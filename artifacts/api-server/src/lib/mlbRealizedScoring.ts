import type { MlbResults as MlbResultsContract } from "@workspace/api-zod";
import { MLB_ROUNDS, type MlbRound } from "./mlbEventAdapter";

export type MlbResults = MlbResultsContract;
export type MlbGame = {
  providerId: string; seriesKey: string; round: MlbRound; gameNumber: number;
  homeTeamId: number; awayTeamId: number; homeName: string; awayName: string;
  scheduledAt: string | null; status: string;
  eventDate?: string;
  homeScore: number | null; awayScore: number | null; sourceUrl: string;
};
export const MLB_RULE_NAMES = [
  "WC Round Win", "WC Sweep", "WC Bye", "LDS Win", "LDS Sweep",
  "LCS Win", "LCS Sweep", "World Series Win", "World Series Sweep",
] as const;
export type MlbRules = Record<typeof MLB_RULE_NAMES[number], number>;
const labels: Record<MlbRound, { label: string; win: keyof MlbRules; sweep: keyof MlbRules }> = {
  wild_card: { label: "Wild Card", win: "WC Round Win", sweep: "WC Sweep" },
  division_series: { label: "Division Series", win: "LDS Win", sweep: "LDS Sweep" },
  league_championship: { label: "League Championship", win: "LCS Win", sweep: "LCS Sweep" },
  world_series: { label: "World Series", win: "World Series Win", sweep: "World Series Sweep" },
};

export function parseMlbRules(rows: Array<{
  ruleName: string; value: string | number | null; active: boolean; ruleType?: string | null;
  multiplier?: string | number | null; calculation?: string | null; condition?: string | null;
}>): MlbRules {
  const rules = {} as MlbRules;
  const expected = new Map(MLB_RULE_NAMES.map((name) => [name.toLowerCase(), name]));
  for (const row of rows.filter((r) => r.active)) {
    const name = expected.get(row.ruleName.trim().replace(/\s+/g, " ").toLowerCase());
    if (!name || row.ruleType && row.ruleType !== "points") {
      throw new Error(`Unsupported MLB points rule: ${row.ruleName}.`);
    }
    if (row.multiplier != null && Number(row.multiplier) !== 1 || row.calculation || row.condition) {
      throw new Error(`Unsupported MLB rule modifiers: ${row.ruleName}.`);
    }
    const value = row.value == null ? NaN : Number(row.value);
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100_000_000)) ||
        Number(value.toFixed(6)) !== value || rules[name] != null) {
      throw new Error(`Invalid or duplicate MLB rule: ${name}.`);
    }
    rules[name] = value;
  }
  for (const name of MLB_RULE_NAMES) if (rules[name] == null) throw new Error(`Missing MLB rule: ${name}.`);
  if (!Object.values(rules).some((v) => v > 0)) throw new Error("MLB rubric has no payable points.");
  return rules;
}

export type MlbPoints = { game: number; sweep: number; bye: number; total: number };
export function calculateMlbActuals(
  games: MlbGame[],
  rules: MlbRules,
  entryTeamIds: number[],
): {
  points: Map<number, MlbPoints>; rounds: MlbResults["rounds"]; series: MlbResults["series"];
  denominator: number; earnedPoints: number; complete: boolean; reasons: string[];
} {
  const reasons: string[] = [];
  if (entryTeamIds.length !== 12 || new Set(entryTeamIds).size !== 12) reasons.push("MLB payout universe must contain all 12 distinct playoff teams.");
  const points = new Map(entryTeamIds.map((id) => [id, { game: 0, sweep: 0, bye: 0, total: 0 }]));
  const award = (id: number, kind: "game" | "sweep" | "bye", amount: number) => {
    const row = points.get(id);
    if (!row) { reasons.push(`Scored MLB team ${id} is outside this pool's payout universe.`); return; }
    row[kind] += amount;
    row.total += amount;
  };
  const bySeries = new Map<string, MlbGame[]>();
  const byId = new Map<string, MlbGame>();
  for (const game of games) {
    const prior = byId.get(game.providerId);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(game)) reasons.push(`Conflicting provider game ${game.providerId}.`);
      continue;
    }
    byId.set(game.providerId, game);
    if (!(game.round in MLB_ROUNDS)) { reasons.push(`Unknown MLB round for ${game.providerId}.`); continue; }
    (bySeries.get(game.seriesKey) ?? bySeries.set(game.seriesKey, []).get(game.seriesKey)!).push(game);
  }
  const series: MlbResults["series"] = [];
  const stats = new Map<MlbRound, { games: number; sweeps: number; completed: number; count: number; inventory: number }>();
  const wcParticipants = new Set<number>();
  const dsParticipants = new Set<number>();
  const winnersByRound = new Map<MlbRound, Set<number>>();
  const participantsByRound = new Map<MlbRound, Set<number>>();
  for (const [key, rows] of [...bySeries].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort((a, b) => a.gameNumber - b.gameNumber || a.providerId.localeCompare(b.providerId));
    const first = rows[0]!;
    const { round } = first;
    const config = MLB_ROUNDS[round];
    const winTarget = (config.bestOf + 1) / 2;
    const teamIds = [first.homeTeamId, first.awayTeamId];
    const wins = new Map(teamIds.map((id) => [id, 0]));
    const priorParticipants = participantsByRound.get(round) ?? new Set<number>();
    for (const id of teamIds) {
      if (priorParticipants.has(id)) reasons.push(`Team ${id} appears in multiple ${round} series.`);
      priorParticipants.add(id);
    }
    participantsByRound.set(round, priorParticipants);
    let clinched = false, counted = 0, sweep = false;
    const numbers = new Set<number>();
    const outputGames: MlbResults["series"][number]["games"] = [];
    for (const game of rows) {
      if (game.round !== round || !teamIds.includes(game.homeTeamId) || !teamIds.includes(game.awayTeamId) ||
          game.homeTeamId === game.awayTeamId || numbers.has(game.gameNumber) ||
          !Number.isInteger(game.gameNumber) || game.gameNumber < 1 || game.gameNumber > config.bestOf) {
        reasons.push(`Ambiguous game/series association for ${game.providerId}.`);
        continue;
      }
      numbers.add(game.gameNumber);
      const unnecessary = clinched;
      outputGames.push({
        providerId: game.providerId, gameNumber: game.gameNumber, scheduledAt: game.scheduledAt,
        status: unnecessary ? "unneeded" : game.status,
        homeTeam: game.homeName, awayTeam: game.awayName,
        homeScore: unnecessary ? null : game.homeScore, awayScore: unnecessary ? null : game.awayScore,
        sourceUrl: game.sourceUrl,
      });
      if (unnecessary || game.status !== "final") continue;
      if (game.gameNumber !== counted + 1 ||
          ![game.homeScore, game.awayScore].every((n) => n != null && Number.isSafeInteger(n) && n >= 0) ||
          game.homeScore === game.awayScore) {
        reasons.push(`Incomplete or invalid final-game coverage for ${key}.`);
        continue;
      }
      const winner = game.homeScore! > game.awayScore! ? game.homeTeamId : game.awayTeamId;
      wins.set(winner, wins.get(winner)! + 1);
      counted++;
      award(winner, "game", rules[labels[round].win]);
      if (wins.get(winner) === winTarget) {
        clinched = true;
        sweep = counted === winTarget;
        if (sweep) award(winner, "sweep", rules[labels[round].sweep]);
      }
    }
    for (const id of teamIds) {
      if (round === "wild_card") wcParticipants.add(id);
      if (round === "division_series") dsParticipants.add(id);
    }
    const inventory = (clinched ? counted : config.bestOf) * rules[labels[round].win] +
      (sweep ? rules[labels[round].sweep] : 0);
    if (clinched) {
      const winner = [...wins].find(([, count]) => count === winTarget)![0];
      const prior = winnersByRound.get(round) ?? new Set<number>();
      prior.add(winner);
      winnersByRound.set(round, prior);
    }
    const current = stats.get(round) ?? { games: 0, sweeps: 0, completed: 0, count: 0, inventory: 0 };
    current.games += counted * rules[labels[round].win];
    current.sweeps += sweep ? rules[labels[round].sweep] : 0;
    current.completed += Number(clinched);
    current.count++;
    current.inventory += inventory;
    stats.set(round, current);
    series.push({
      key, round, bestOf: config.bestOf, homeTeam: first.homeName, awayTeam: first.awayName,
      homeWins: wins.get(first.homeTeamId)!, awayWins: wins.get(first.awayTeamId)!,
      complete: clinched, sweep, inventoryPoints: inventory, games: outputGames,
    });
  }
  // In the modern MLB format, a DS participant absent from the complete WC
  // universe is a bye entrant. A missing WC game or partial DS schedule is not
  // evidence of a bye. Retain the contributing provider games in the calendar.
  const wcComplete = stats.get("wild_card")?.completed === 4 && wcParticipants.size === 8;
  const byes = [...dsParticipants].filter((id) => !wcParticipants.has(id));
  const byesVerified = wcComplete && dsParticipants.size === 8 && byes.length === 4 &&
    byes.every((id) => points.has(id));
  if (wcComplete) for (const id of dsParticipants) {
    if (wcParticipants.has(id) && !winnersByRound.get("wild_card")?.has(id)) reasons.push(`DS team ${id} has not advanced from its WC series.`);
  }
  for (const [round, previous] of [
    ["league_championship", "division_series"], ["world_series", "league_championship"],
  ] as const) {
    for (const id of participantsByRound.get(round) ?? []) {
      if (!winnersByRound.get(previous)?.has(id)) reasons.push(`${round} team ${id} has no verified advancement from ${previous}.`);
    }
  }
  if (!byesVerified) reasons.push("Wild Card bye evidence is incomplete; need all four completed WC series and all four DS matchups.");
  if (byesVerified) for (const id of byes) award(id, "bye", rules["WC Bye"]);
  const rounds = (Object.keys(MLB_ROUNDS) as MlbRound[]).map((round) => {
    const config = MLB_ROUNDS[round];
    const current = stats.get(round) ?? { games: 0, sweeps: 0, completed: 0, count: 0, inventory: 0 };
    if (current.count > config.seriesCount) reasons.push(`Too many ${labels[round].label} series.`);
    const byePoints = round === "wild_card" && byesVerified ? byes.length * rules["WC Bye"] : 0;
    return {
      key: round, label: labels[round].label, bestOf: config.bestOf, seriesCount: config.seriesCount,
      completedSeries: current.completed, gamePoints: current.games, sweepPoints: current.sweeps,
      byePoints,
      inventoryPoints: current.inventory +
        Math.max(0, config.seriesCount - current.count) * config.bestOf * rules[labels[round].win] + byePoints,
    };
  });
  const denominator = rounds.reduce((sum, row) => sum + row.inventoryPoints, 0);
  const earnedPoints = [...points.values()].reduce((sum, row) => sum + row.total, 0);
  if (!(denominator > 0)) reasons.push("MLB point inventory is not positive.");
  return {
    points, rounds, series, denominator, earnedPoints,
    complete: rounds.every((row) => row.completedSeries === row.seriesCount),
    reasons: [...new Set(reasons)],
  };
}

/** Largest-remainder allocation: exactly conserve earned cents and, at the
 * terminal outcome, the whole pot. No revaluation is a new earned award. */
export function allocateMlbCents(potCents: number, denominator: number, teamPoints: Map<number, MlbPoints>): Map<number, number> {
  if (!Number.isSafeInteger(potCents) || potCents < 0 || !Number.isFinite(denominator) || denominator <= 0) {
    throw new Error("Invalid MLB pot or denominator.");
  }
  const scale = 1_000_000;
  const divisor = BigInt(Math.round(denominator * scale));
  if (!Number.isSafeInteger(Math.round(denominator * scale))) throw new Error("MLB inventory exceeds supported precision.");
  const rows = [...teamPoints].sort(([a], [b]) => a - b).map(([id, points]) => {
    const units = Math.round(points.total * scale);
    if (!Number.isSafeInteger(units) || units < 0) throw new Error("MLB points exceed supported precision.");
    const numerator = BigInt(potCents) * BigInt(units);
    return { id, cents: numerator / divisor, remainder: numerator % divisor, numerator };
  });
  const earnedNumerator = rows.reduce((n, row) => n + row.numerator, 0n);
  const target = (earnedNumerator * 2n + divisor) / (2n * divisor);
  let remaining = Number(target - rows.reduce((n, row) => n + row.cents, 0n));
  for (const row of [...rows].sort((a, b) => a.remainder === b.remainder ? a.id - b.id : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining-- > 0) row.cents++;
  }
  return new Map(rows.map((row) => [row.id, Number(row.cents)]));
}
