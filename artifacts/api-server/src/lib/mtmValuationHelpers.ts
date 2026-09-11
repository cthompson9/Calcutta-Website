export type ConditionalRow = {
  eventId: number; entryId: number; outcome: "home_win" | "away_win" | "tie";
  team: string; grossBaseline: number | null; grossConditional: number | null;
  grossDelta: number | null; probability: number | null; sampleCount: number | null;
  sampleShare: number | null; effectiveSampleSize: number | null; standardError: number | null;
  qualityStatus: "good" | "warning" | "insufficient"; reconciliationResidual: number | null;
};

type SwingConditionalTeam = {
  team_id: number | null;
  gross_baseline: number | null;
  gross_expected_payout: number | null;
  sample_count: number | null;
  sample_share: number | null;
  effective_sample_size: number | null;
  standard_error: number | null;
  quality_status: "good" | "warning" | "insufficient";
};

type SwingConditionalEvent = {
  event_id: number;
  home: number | null;
  away: number | null;
  week: number | null;
  outcomes: Partial<Record<"home_win" | "away_win" | "tie", {
    teams: SwingConditionalTeam[];
  }>>;
};

type GameEvSwing = ReturnType<typeof deriveGameEvSwings>[number];

export function deriveOwnerGameEvSwings(
  games: GameEvSwing[],
  owners: Array<{
    bidderId: number;
    bidderName: string;
    positions: Map<number, { effectiveShare: number }>;
  }>,
) {
  return games.map((game) => ({
    ...game,
    owners: owners.flatMap((owner) => {
      const holdings = game.teams.flatMap((team) => {
        const position = team.teamId == null ? undefined : owner.positions.get(team.teamId);
        if (!position || position.effectiveShare === 0) return [];
        const owned = (value: number | null) => value == null ? null : value * position.effectiveShare;
        return [{
          teamId: team.teamId,
          teamName: team.teamName,
          signedShare: position.effectiveShare,
          available: team.available,
          qualityStatus: team.qualityStatus,
          baselineOwnedExpectedPayout: owned(team.baselineGrossExpectedPayout),
          winOwnedExpectedPayout: owned(team.winGrossExpectedPayout),
          lossOwnedExpectedPayout: owned(team.lossGrossExpectedPayout),
          benefitOfWin: owned(team.benefitOfWin),
          costOfLoss: owned(team.costOfLoss),
          totalEvSwing: owned(team.totalEvSwing),
          effectiveSampleSize: team.effectiveSampleSize,
        }];
      });
      return holdings.length ? [{
        bidderId: owner.bidderId,
        bidderName: owner.bidderName,
        holdings,
      }] : [];
    }),
  }));
}

function minNullable(values: Array<number | null | undefined>) {
  const present = values.filter((value): value is number => value != null);
  return present.length ? Math.min(...present) : null;
}

function maxNullable(values: Array<number | null | undefined>) {
  const present = values.filter((value): value is number => value != null);
  return present.length ? Math.max(...present) : null;
}

export function deriveGameEvSwings(
  events: SwingConditionalEvent[],
  teamNames: Map<number, string | null>,
) {
  return events.map((event) => {
    const swingFor = (
      teamId: number | null,
      winOutcome: "home_win" | "away_win",
      lossOutcome: "home_win" | "away_win",
    ) => {
      const win = event.outcomes[winOutcome]?.teams.find((team) => team.team_id === teamId);
      const loss = event.outcomes[lossOutcome]?.teams.find((team) => team.team_id === teamId);
      const baseline = win?.gross_baseline ?? loss?.gross_baseline ?? null;
      const winGross = win?.gross_expected_payout ?? null;
      const lossGross = loss?.gross_expected_payout ?? null;
      const qualityStatus = !win || !loss ||
        win.quality_status === "insufficient" || loss.quality_status === "insufficient"
        ? "insufficient"
        : win.quality_status === "warning" || loss.quality_status === "warning"
          ? "warning"
          : "good";
      const available = qualityStatus === "good" &&
        baseline != null && winGross != null && lossGross != null;
      return {
        teamId,
        teamName: teamId == null ? null : teamNames.get(teamId) ?? null,
        available,
        qualityStatus,
        baselineGrossExpectedPayout: available ? baseline : null,
        winGrossExpectedPayout: available ? winGross : null,
        lossGrossExpectedPayout: available ? lossGross : null,
        benefitOfWin: available ? winGross - baseline : null,
        costOfLoss: available ? baseline - lossGross : null,
        totalEvSwing: available ? winGross - lossGross : null,
        sampleCount: minNullable([win?.sample_count, loss?.sample_count]),
        sampleShare: minNullable([win?.sample_share, loss?.sample_share]),
        effectiveSampleSize: minNullable([
          win?.effective_sample_size,
          loss?.effective_sample_size,
        ]),
        standardError: maxNullable([win?.standard_error, loss?.standard_error]),
      };
    };
    return {
      eventId: event.event_id,
      week: event.week,
      homeTeamId: event.home,
      awayTeamId: event.away,
      teams: [
        swingFor(event.home, "home_win", "away_win"),
        swingFor(event.away, "away_win", "home_win"),
      ],
    };
  });
}

export function flattenEngineConditionals(
  conditionals: Record<string, any>,
  entryByTeam: Map<string, number>,
  baselineByEntry: Map<number, number>,
): ConditionalRow[] {
  const rows: ConditionalRow[] = [];
  for (const game of Object.values(conditionals ?? {})) {
    const eventId = Number(game.event_id);
    for (const outcome of ["home_win", "away_win", "tie"] as const) {
      for (const [team, bucket] of Object.entries(game.outcomes?.[outcome] ?? {})) {
        const entryId = entryByTeam.get(team);
        const data = bucket as any;
        if (entryId == null) throw new Error(`Conditional team ${team} is not present in the engine state.`);
        const gross = data?.gross_expected_payout == null ? null : Number(data.gross_expected_payout);
        const baseline = baselineByEntry.get(entryId) ?? null;
        rows.push({
          eventId, entryId, outcome, team, grossBaseline: baseline, grossConditional: gross,
          grossDelta: gross == null || baseline == null ? null : gross - baseline,
          probability: data?.sample_share == null ? null : Number(data.sample_share),
          sampleCount: data?.sample_count == null ? null : Number(data.sample_count),
          sampleShare: data?.sample_share == null ? null : Number(data.sample_share),
          effectiveSampleSize: data?.effective_sample_size == null ? null : Number(data.effective_sample_size),
          standardError: data?.standard_error == null ? null : Number(data.standard_error),
          qualityStatus: data?.quality_status ?? "insufficient",
          reconciliationResidual: data?.reconciliation_residual == null ? null : Number(data.reconciliation_residual),
        });
      }
    }
  }
  return rows;
}

export function chooseProvisionalOutcome(args: {
  actualAnchor: string | Date | null;
  candidates: Array<{ eventId: number; final: boolean; completeIdentity: boolean; completeScore: boolean; observedAt: string | Date | null; actualAnchor: string | Date | null; homeScore: number | null; awayScore: number | null }>;
  conditionalQuality: Map<string, Array<{ qualityStatus: string; grossConditional: number | null }>>;
}) {
  const after = args.candidates.filter((event) => event.final && event.completeIdentity && event.completeScore &&
    event.observedAt != null && args.actualAnchor != null && new Date(event.observedAt) > new Date(args.actualAnchor));
  const incomplete = args.candidates.some((event) => event.final && (!event.completeIdentity || !event.completeScore));
  if (incomplete) return { selected: false, reason: "incomplete final identity or score" as const };
  if (after.length === 0) return { selected: false, reason: "zero unanchored finals" as const };
  if (after.length > 1) return { selected: false, reason: "multiple unanchored finals" as const };
  const event = after[0]!;
  const outcome = event.homeScore! > event.awayScore! ? "home_win" : event.awayScore! > event.homeScore! ? "away_win" : "tie";
  const rows = args.conditionalQuality.get(`${event.eventId}:${outcome}`) ?? [];
  if (rows.length < 32 || rows.some((row) => row.grossConditional == null || !["good", "warning"].includes(row.qualityStatus))) {
    return { selected: false, reason: "insufficient conditional quality" as const };
  }
  return { selected: true, eventId: event.eventId, outcome, reason: "final margin is not incorporated" as const };
}

export function computeValuationInvariants(args: {
  expectedPot: number; teams: Array<{ gross: number; auctionPrice: number }>;
  secondaryTradePaid: number; secondaryTradeReceived: number;
}) {
  const observed = args.teams.reduce((sum, row) => sum + row.gross, 0);
  const auction = args.teams.reduce((sum, row) => sum + row.auctionPrice, 0);
  const entryObserved = observed - auction;
  const entryExpected = args.expectedPot - auction;
  const tradeObserved = args.secondaryTradePaid - args.secondaryTradeReceived;
  const result = (residual: number) => ({ observed: residual === 0 ? 0 : residual, expected: 0, residual, status: Math.abs(residual) < 0.01 ? "ok" : "warning" });
  return {
    teamGrossPoolConservation: { expected: args.expectedPot, observed, residual: observed - args.expectedPot, status: Math.abs(observed - args.expectedPot) < 0.01 ? "ok" : "warning" },
    entryNetVersusAuctionProceeds: { expected: entryExpected, observed: entryObserved, residual: entryObserved - entryExpected, status: Math.abs(entryObserved - entryExpected) < 0.01 ? "ok" : "warning" },
    ownerSecondaryTradeCash: result(tradeObserved),
  };
}

export function calculateSignedOwnerValue(gross: number, share: number, originalCost: number, paid: number, received: number) {
  const signedCostBasis = originalCost + paid - received;
  return { gross: gross * share, signedCostBasis, net: gross * share - signedCostBasis };
}

export function calculateMidpointDrift(
  before: Array<{ ticker: string; bid: number | null; ask: number | null; volume?: number | null }>,
  after: Array<{ ticker: string; bid: number | null; ask: number | null; volume?: number | null }>,
  threshold = 0.05,
) {
  const later = new Map(after.map((row) => [row.ticker, row]));
  const comparable = before.flatMap((row) => {
    const next = later.get(row.ticker);
    if (next?.bid == null || next.ask == null || row.bid == null || row.ask == null) return [];
    return [{ drift: Math.abs((next.bid + next.ask) / 2 - (row.bid + row.ask) / 2), weight: Math.max(0, next.volume ?? row.volume ?? 0) }];
  });
  if (!comparable.length) return { available: false, comparedTickerCount: 0, maxDrift: null, weightedDrift: null, recommendsRerun: false, threshold };
  const weight = comparable.reduce((sum, row) => sum + row.weight, 0) || comparable.length;
  const maxDrift = Math.max(...comparable.map((row) => row.drift));
  const weightedDrift = comparable.reduce((sum, row) => sum + row.drift * (row.weight || 1), 0) / weight;
  return { available: true, comparedTickerCount: comparable.length, maxDrift, weightedDrift: Math.round(weightedDrift * 1e8) / 1e8, recommendsRerun: maxDrift >= threshold, threshold };
}