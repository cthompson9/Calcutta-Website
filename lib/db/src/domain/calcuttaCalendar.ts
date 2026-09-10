import { calendarFormats, scheduleStates } from "../schema/calcuttaCalendar";

export type CalendarFormat = (typeof calendarFormats)[number];
export type ParticipantSeed = { seed?: number | null; designation?: "home" | "away" | null };

export function validateParticipantSeed(value: ParticipantSeed): void {
  if (value.seed != null && (!Number.isInteger(value.seed) || value.seed < 1)) throw new Error("seed must be a positive integer");
  if (value.designation === "home" && value.seed == null) throw new Error("home designation requires a known seed");
}

/** Higher (better) seed is the default home team; ties and unknown seeds remain unresolved. */
export function superiorSeedDesignation(a: ParticipantSeed, b: ParticipantSeed, neutralSite = false): "home" | "away" | null {
  validateParticipantSeed(a); validateParticipantSeed(b);
  if (a.seed == null || b.seed == null || a.seed === b.seed) return null;
  return a.seed < b.seed ? "home" : "away";
}

export function buildRoundShape(format: CalendarFormat, mlbBestOf?: 3 | 5 | 7): number[] {
  switch (format) {
    case "nfl_single_elimination": return [6, 4, 2, 1];
    case "nba_seven_game": return [1];
    case "mlb_series": if (!mlbBestOf) throw new Error("MLB requires a round-specific best-of value"); return [1];
    case "march_madness_64": return [32, 16, 8, 4, 2, 1];
  }
}

export function buildNflBracket(participantCount = 14) {
  validateCalendarShape("nfl_single_elimination", participantCount);
  return { format: "nfl_single_elimination" as const, teams: 14, rounds: ["wild_card", "divisional", "conference", "championship"], topSeedByes: 2, reseedDivisional: true };
}

export function buildNbaSeries() {
  return { format: "nba_seven_game" as const, bestOf: 7, rounds: ["series"] };
}

export function buildMlbSeries(roundBestOf: Array<3 | 5 | 7>) {
  if (!roundBestOf.length || roundBestOf.some((value) => ![3, 5, 7].includes(value))) throw new Error("MLB rounds must be best-of-3, best-of-5, or best-of-7");
  return { format: "mlb_series" as const, roundBestOf: [...roundBestOf] };
}

export function buildMarchMadnessBracket(participantCount = 64) {
  validateCalendarShape("march_madness_64", participantCount);
  return { format: "march_madness_64" as const, teams: 64, rounds: ["round_of_64", "round_of_32", "sweet_16", "elite_8", "final_four", "championship"], firstFour: false };
}

export function validateCalendarShape(format: CalendarFormat, participantCount: number, mlbBestOf?: 3 | 5 | 7): void {
  if (!calendarFormats.includes(format)) throw new Error("unsupported calendar format");
  if (format === "march_madness_64" && participantCount !== 64) throw new Error("March Madness requires exactly 64 teams (without First Four)");
  if (format === "nfl_single_elimination" && participantCount !== 14) throw new Error("NFL playoff bracket requires 14 teams");
  if ((format === "nba_seven_game" || format === "mlb_series") && participantCount < 2) throw new Error("series requires at least two teams");
  if (format === "mlb_series" && !mlbBestOf) throw new Error("MLB requires a best-of value for each round");
}

/** NFL's later rounds are reseeded: every slot is paired from the strongest and weakest remaining seeds. */
export function nflReseedPairings(seeds: number[]): Array<[number, number]> {
  const ordered = [...seeds].sort((a, b) => a - b);
  if (ordered.length < 2 || ordered.length % 2 !== 0) throw new Error("NFL reseeding requires an even number of remaining teams");
  return ordered.slice(0, ordered.length / 2).map((seed, i) => [seed, ordered[ordered.length - 1 - i]]);
}

export function validateProjectionSnapshot(input: { mtmStatus: string; status: "available" | "unavailable"; unavailableReason?: string | null }): void {
  if (input.mtmStatus !== "ok") throw new Error("calendar projection must reference a successful MTM snapshot");
  if (input.status === "unavailable" && !input.unavailableReason) throw new Error("unavailable projections require a reason");
}

/** Slot topology is scoped to one competition; never couple slots across calendars. */
export function validateSlotCoupling(calendarId: number, referencedCalendarId: number): void {
  if (!Number.isInteger(calendarId) || !Number.isInteger(referencedCalendarId) || calendarId !== referencedCalendarId) {
    throw new Error("calendar slot references must belong to the same competition");
  }
}

export function validateScheduleState(state: (typeof scheduleStates)[number], reason?: string | null): void {
  if (state === "not_applicable" && !reason) throw new Error("not_applicable schedules require an absence reason");
}