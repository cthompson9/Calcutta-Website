import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { currentYearInNewYork } from "./newYorkTime";
import {
  resolveDefaultSeasonYearForSport,
  resolveSeasonIdForSport,
} from "./calcuttaContext";
import { applyNflStandingsImport } from "./nflStandingsImport";
import {
  fetchEspnNflEvents,
  validateEspnRegularSeasonEvents,
  type EspnScoreboardPayload,
} from "./nflEventSync";

export async function resolveNflStandingsRefreshSeasonYear(): Promise<number> {
  const activeYear = await resolveDefaultSeasonYearForSport(db, {
    sport: "NFL",
    state: "active",
    newestFirst: true,
  });
  if (activeYear != null) return activeYear;

  const currentYear = currentYearInNewYork();
  const currentSeasonId = await resolveSeasonIdForSport(db, {
    year: currentYear,
    sport: "NFL",
  });
  if (currentSeasonId != null) return currentYear;

  throw new Error(
    `No active season or ${currentYear} season is configured for the NFL standings refresh.`,
  );
}

export async function resolveNflEventPayload(
  seasonYear: number,
  provided?: EspnScoreboardPayload,
): Promise<EspnScoreboardPayload> {
  return provided ?? await fetchEspnNflEvents(seasonYear);
}

export async function runNflStandingsRefresh(input: {
  requestedBy: string;
  requestId?: string;
  seasonYear?: number;
  eventPayload?: EspnScoreboardPayload;
  reconcileMtm?: boolean;
  runMtmInline?: boolean;
}): Promise<Awaited<ReturnType<typeof applyNflStandingsImport>>> {
  const seasonYear = input.seasonYear ?? await resolveNflStandingsRefreshSeasonYear();
  const seasonId = await resolveSeasonIdForSport(db, { year: seasonYear, sport: "NFL" });
  if (seasonId == null) {
    throw new Error(`Season ${seasonYear} has no canonical NFL Calcutta.`);
  }
  // Fetch and validate the complete event ledger before committing standings.
  // Provider outages or partial payloads therefore leave the refresh untouched.
  const eventPayload = await resolveNflEventPayload(seasonYear, input.eventPayload);
  validateEspnRegularSeasonEvents(eventPayload, seasonYear);
  const standings = await applyNflStandingsImport({
    seasonYear,
    requestedBy: input.requestedBy,
    requestId: input.requestId ?? randomUUID(),
    eventPayload,
    reconcileMtm: input.reconcileMtm,
    runMtmInline: input.runMtmInline,
  });
  return standings;
}