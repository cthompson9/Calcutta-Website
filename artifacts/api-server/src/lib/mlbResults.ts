import { eq } from "drizzle-orm";
import {
  db, calcuttaEntriesTable, calcuttaRulesTable, teamsTable, refreshJobStatesTable,
  auctionSessionsTable, auctionConsortiaTable, auctionConsortiumOwnersTable,
} from "@workspace/db";
import { loadSeasonOwnership, type OwnerEntry } from "./seasonOwnership";
import { calculateOwnerResultEconomics } from "./ownerResultEconomics";
import { isMlbGameWindowOpen, loadMlbGames } from "./mlbEventSync";
import {
  emptyMlbCache, loadMlbPool, mlbDiscoveryDates, mlbIdentityMigrationReady,
  mlbRefreshScope, readMlbCache,
} from "./mlbRefresh";
import {
  allocateMlbCents, calculateMlbActuals, MLB_RULE_NAMES, normalizeMlbRuleName, type MlbResults,
} from "./mlbRealizedScoring";
import { ESPN_MLB_SCOREBOARD_URL } from "./mlbEspnClient";
import { getSeriesActualsAdapter } from "./competitionScoring";
import { allocateExactCents, decimalFraction, fraction, sumFractions } from "./exactOwnershipFractions";

type OwnerResult = MlbResults["teams"][number]["owners"][number];
const money = (value: number) => Math.round(value * 100) / 100;

/** Signed stakes must reconcile too: shorts use mathematical floor, not
 * BigInt's truncation toward zero. The remainder is allocated deterministically. */
export function allocateSignedMlbCents(
  target: number, rows: Array<{ id: number; numerator: bigint }>, divisor: bigint,
): Map<number, number> {
  const divided = rows.map(({ id, numerator }) => {
    let cents = numerator / divisor;
    let remainder = numerator % divisor;
    if (remainder < 0n) { cents--; remainder += divisor; }
    return { id, cents, remainder };
  });
  let left = target - Number(divided.reduce((total, row) => total + row.cents, 0n));
  if (!Number.isSafeInteger(left) || left < 0 || left > rows.length) throw new Error("MLB signed money allocation does not reconcile.");
  for (const row of [...divided].sort((a, b) => a.remainder === b.remainder ? a.id - b.id : a.remainder > b.remainder ? -1 : 1)) {
    if (left-- > 0) row.cents++;
  }
  return new Map(divided.map((row) => [row.id, Number(row.cents)]));
}

export async function getMlbResults(
  calcuttaId: number,
  options: { database?: typeof db; now?: Date; enabled?: boolean } = {},
): Promise<MlbResults | null> {
  const database = options.database ?? db;
  const now = options.now ?? new Date();
  const enabled = options.enabled ?? process.env.MLB_RESULTS_ENABLED === "true";
  // One coherent read snapshot across rule, inventory, event and signed-ledger
  // changes. No ingestion, payout writes, or MTM happens on this read path.
  return database.transaction(async (tx) => {
    const pool = await loadMlbPool(calcuttaId, tx);
    if (!pool) return null;
    const reasons: string[] = [];
    const blocking: string[] = [];
    const [state] = await tx.select().from(refreshJobStatesTable).where(mlbRefreshScope(pool));
    let cache = emptyMlbCache();
    try { cache = readMlbCache(state?.scheduleCache); }
    catch (error) { blocking.push(String(error)); }
    const requiredDates = mlbDiscoveryDates(pool.year, now);
    const asOfDates = mlbDiscoveryDates(pool.year, state?.lastSucceededAt ?? now);
    const coveredDays = requiredDates.filter((date) => cache.covered[date]).length;
    const missingAsOf = asOfDates.filter((date) => !cache.covered[date]);
    if (!enabled) reasons.push("Automatic MLB results refresh is not activated.");
    if (!await mlbIdentityMigrationReady(tx)) blocking.push("MLB event identity migration is awaiting separate authorization.");
    if (!state?.lastSucceededAt) blocking.push("No successful MLB source refresh is available.");
    if (missingAsOf.length) blocking.push(`Postseason discovery is incomplete (${asOfDates.length - missingAsOf.length}/${asOfDates.length} days).`);
    if (coveredDays < requiredDates.length && !missingAsOf.length) reasons.push("The retained actuals precede today's schedule discovery.");
    if (state?.lastError) reasons.push(`Refresh failed: ${state.lastError}`);
    let stale = !state?.lastSucceededAt || coveredDays < requiredDates.length ||
      Boolean(state.lastFailedAt && state.lastFailedAt >= state.lastSucceededAt) ||
      now.getTime() - state.lastSucceededAt.getTime() > 36 * 60 * 60_000;
    if (stale && state?.lastSucceededAt) reasons.push("Retained actuals are stale; they are not a current provider snapshot.");
    const rules = await tx.select().from(calcuttaRulesTable).where(eq(calcuttaRulesTable.calcuttaId, pool.id));
    const displayedRules = MLB_RULE_NAMES.map((name) => {
      const row = rules.filter((r) => r.active && normalizeMlbRuleName(r.ruleName) === name.toLowerCase());
      const value = row.length === 1 && row[0]!.value != null ? Number(row[0]!.value) : null;
      return { name, points: value != null && Number.isFinite(value) ? value : null };
    });
    const entries = await tx.select({ entryId: calcuttaEntriesTable.id, teamId: teamsTable.id, name: teamsTable.name, sport: teamsTable.sport })
      .from(calcuttaEntriesTable).innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
      .where(eq(calcuttaEntriesTable.calcuttaId, pool.id));
    if (entries.length !== 12 || entries.some((e) => e.sport !== "MLB")) blocking.push("The payout universe must contain 12 MLB teams.");
    let actuals: ReturnType<typeof calculateMlbActuals> | null = null;
    try {
      const adapter = getSeriesActualsAdapter(pool.sport, pool.competitionFormat);
      if (!adapter) throw new Error("This pool has no supported series-actuals adapter.");
      const games = await loadMlbGames(tx, pool.seasonId);
      if (state?.lastSucceededAt && isMlbGameWindowOpen(games, now) &&
          now.getTime() - state.lastSucceededAt.getTime() > 10 * 60_000) {
        stale = true;
        reasons.push("The game-window source check is overdue; retained actuals are not current.");
      }
      actuals = adapter.calculateActuals(games, adapter.validateRules(rules), entries.map((e) => e.teamId));
      blocking.push(...actuals.reasons);
    } catch (error) { blocking.push(error instanceof Error ? error.message : String(error)); }
    const ownership = await loadSeasonOwnership(pool.seasonId, pool.id, tx);
    const rawOwners = new Map<number, Array<{ id: number; entry: OwnerEntry }>>();
    for (const [id, teams] of ownership.byBidder) for (const [teamId, entry] of teams) {
      (rawOwners.get(teamId) ?? rawOwners.set(teamId, []).get(teamId)!).push({ id, entry });
    }
    let potCents = 0, potValid = entries.length === 12;
    const primaryCents = new Map<number, number>();
    for (const team of entries) {
      const owners = rawOwners.get(team.teamId) ?? [];
      const originalExact = sumFractions(owners.map(row => row.entry.originalFraction ?? decimalFraction(row.entry.originalShare)));
      const effectiveExact = sumFractions(owners.map(row => row.entry.effectiveFraction ?? decimalFraction(row.entry.effectiveShare)));
      const originalUnits = pool.id === 2061
        ? (originalExact.numerator === originalExact.denominator ? 10_000 : 0)
        : owners.reduce((total, row) => total + Math.round(row.entry.originalShare * 10_000), 0);
      const effectiveUnits = pool.id === 2061
        ? (effectiveExact.numerator === effectiveExact.denominator ? 10_000 : 0)
        : owners.reduce((total, row) => total + Math.round(row.entry.effectiveShare * 10_000), 0);
      const rawCost = owners.reduce((total, row) => total + row.entry.originalCostBasis, 0);
      const cents = Math.round(rawCost * 100);
      if (originalUnits !== 10_000 || effectiveUnits !== 10_000 ||
          !Number.isSafeInteger(cents) || cents < 0 || Math.abs(rawCost * 100 - cents) > 0.001) {
        potValid = false;
        blocking.push(`Auction/ownership coverage for ${team.name} is incomplete or does not reconcile.`);
      }
      primaryCents.set(team.teamId, cents);
      potCents += cents;
    }
    if (!Number.isSafeInteger(potCents) || potCents <= 0) potValid = false;
    if (!potValid) blocking.push("The selected pool's sold pot is not fully verified.");
    const available = blocking.length === 0 && actuals != null && potValid;
    let grossByTeam = new Map<number, number>();
    if (available && actuals) grossByTeam = allocateMlbCents(potCents, actuals.denominator, actuals.points);
    const teams: MlbResults["teams"] = [];
    for (const team of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const signed = rawOwners.get(team.teamId) ?? [];
      const points = available ? actuals!.points.get(team.teamId)! : null;
      const grossCents = available ? grossByTeam.get(team.teamId)! : null;
      const costCents = primaryCents.get(team.teamId) ?? 0;
      let ownerGross = new Map<number, number>(), ownerCosts = new Map<number, number>();
      if (grossCents != null) ownerGross = pool.id === 2061
        ? allocateExactCents(grossCents, signed.map(row => ({
            id: row.id, share: row.entry.effectiveFraction ?? fraction(BigInt(Math.round(row.entry.effectiveShare * 1_000_000)), 1_000_000n),
          })))
        : allocateSignedMlbCents(grossCents, signed.map(row => ({
            id: row.id, numerator: BigInt(grossCents) * BigInt(Math.round(row.entry.effectiveShare * 10_000)),
          })), 10_000n);
      if (signed.length) ownerCosts = allocateSignedMlbCents(costCents, signed.map((row) => ({
        id: row.id, numerator: BigInt(Math.round((row.entry.originalCostBasis + row.entry.tradePaid - row.entry.tradeReceived) * 10_000)),
      })), 100n);
      const owners: OwnerResult[] = signed.map((row) => {
        const shared = calculateOwnerResultEconomics({
          ...row.entry, realizedTeamGross: grossCents == null ? 0 : grossCents / 100,
          mtmTeamGross: 0, dollarsPerPoint: available ? potCents / 100 / actuals!.denominator : null,
        });
        const gross = grossCents == null ? null : ownerGross.get(row.id)! / 100;
        const cost = ownerCosts.has(row.id) ? ownerCosts.get(row.id)! / 100 : shared.cost;
        return {
          bidderId: row.id, name: ownership.bidderNames.get(row.id) ?? "Unknown owner",
          share: pool.id === 2061 ? row.entry.effectiveShare : Number(row.entry.effectiveShare.toFixed(4)),
          points: points == null ? null : Number((points.total * row.entry.effectiveShare).toFixed(6)),
          cost, gross, net: gross == null ? null : money(gross - cost),
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
      teams.push({
        entryId: team.entryId, teamId: team.teamId, name: team.name,
        gamePoints: points?.game ?? null, sweepPoints: points?.sweep ?? null, byePoints: points?.bye ?? null,
        points: points?.total ?? null, cost: costCents / 100, gross: grossCents == null ? null : grossCents / 100,
        net: grossCents == null ? null : (grossCents - costCents) / 100, owners,
      });
    }
    const [auction] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.calcuttaId, pool.id));
    const consortia = auction ? await tx.select().from(auctionConsortiaTable).where(eq(auctionConsortiaTable.auctionId, auction.id)) : [];
    const members = auction ? await tx.select().from(auctionConsortiumOwnersTable).where(eq(auctionConsortiumOwnersTable.auctionId, auction.id)) : [];
    const consortiumById = new Map(consortia.map((c) => [c.id, c]));
    const memberByBidder = new Map<number, typeof members[number]>();
    for (const member of members) {
      if (memberByBidder.has(member.bidderId)) throw new Error("MLB consortium membership is ambiguous.");
      memberByBidder.set(member.bidderId, member);
    }
    const groups = new Map<string, MlbResults["consortia"][number]>();
    for (const team of teams) for (const owner of team.owners) {
      const member = memberByBidder.get(owner.bidderId);
      const consortium = member ? consortiumById.get(member.consortiumId) : null;
      const key = consortium ? `consortium:${consortium.id}` : `bidder:${owner.bidderId}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, name: consortium?.displayName ?? owner.name, points: available ? 0 : null,
          cost: 0, gross: available ? 0 : null, net: available ? 0 : null, members: [] };
        groups.set(key, group);
      }
      group.cost = money(group.cost + owner.cost);
      if (owner.points != null && group.points != null) group.points = Number((group.points + owner.points).toFixed(6));
      if (owner.gross != null && group.gross != null) group.gross = money(group.gross + owner.gross);
      group.net = group.gross == null ? null : money(group.gross - group.cost);
      let aggregate = group.members.find((m) => m.bidderId === owner.bidderId);
      if (!aggregate) {
        aggregate = { ...owner, share: member ? Number(member.share) : 1, points: available ? 0 : null,
          cost: 0, gross: available ? 0 : null, net: available ? 0 : null };
        group.members.push(aggregate);
      }
      aggregate.cost = money(aggregate.cost + owner.cost);
      if (aggregate.points != null && owner.points != null) aggregate.points = Number((aggregate.points + owner.points).toFixed(6));
      if (aggregate.gross != null && owner.gross != null) aggregate.gross = money(aggregate.gross + owner.gross);
      aggregate.net = aggregate.gross == null ? null : money(aggregate.gross - aggregate.cost);
    }
    return {
      calcuttaId: pool.id, name: pool.name, year: pool.year,
      status: available && !reasons.length ? "available" : state?.lastSucceededAt ? "partial" : "unavailable",
      reasons: [...new Set([...blocking, ...reasons])], pot: potValid ? potCents / 100 : null,
      provisionalPoints: available ? actuals!.denominator : null, earnedPoints: available ? actuals!.earnedPoints : null,
      dollarsPerPoint: available ? potCents / 100 / actuals!.denominator : null,
      tournamentComplete: available && actuals!.complete,
      rules: displayedRules, rounds: available ? actuals!.rounds : [], series: actuals?.series ?? [], teams,
      consortia: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
      mtmReason: "MLB projected MTM is unavailable. These are realized points valued at a provisional rate, not forecasts or cash settlements.",
      refresh: {
        enabled, lastAttempt: state?.lastAttemptedAt?.toISOString() ?? null,
        lastSuccess: state?.lastSucceededAt?.toISOString() ?? null, lastFailure: state?.lastFailedAt?.toISOString() ?? null,
        error: state?.lastError ?? null, nextRetry: cache.retryAt ?? cache.pollAt,
        coveredDays, requiredDays: requiredDates.length, sourceUrl: ESPN_MLB_SCOREBOARD_URL, stale,
      },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
