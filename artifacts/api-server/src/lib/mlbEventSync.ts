import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db, eventsTable, calcuttaEntriesTable, teamsTable,
  calcuttaCalendarsTable, calendarParticipantsTable, calendarRoundsTable,
  calendarSlotsTable, calendarSlotCandidatesTable, calendarSeriesTable,
  calendarGamesTable, calendarContingentGamesTable,
} from "@workspace/db";
import { MLB_ROUNDS, parseEspnMlbPostseason, resolveMlbParticipant, type MlbRound } from "./mlbEventAdapter";
import type { EspnMlbPayload } from "./mlbEspnClient";
import type { MlbGame } from "./mlbRealizedScoring";
import { todayInNewYork } from "./newYorkTime";

export type MlbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type MlbPool = { id: number; seasonId: number; year: number; sport: string; competitionFormat: string; name: string };
export const MLB_SCOPE = { sport: "MLB", competition: "MLB_POSTSEASON", source: "espn" } as const;
export function isMlbGameWindowOpen(games: MlbGame[], now: Date): boolean {
  return games.some((game) => game.status !== "cancelled" &&
    (game.scheduledAt != null
      ? now.getTime() >= Date.parse(game.scheduledAt) &&
        now.getTime() <= Date.parse(game.scheduledAt) + (game.status === "final" ? 6 : 14) * 60 * 60_000
      : game.eventDate === todayInNewYork(now)));
}

export async function loadMlbGames(database: Pick<typeof db, "select">, seasonId: number): Promise<MlbGame[]> {
  const rows = await database.select().from(eventsTable).where(and(
    eq(eventsTable.seasonId, seasonId), eq(eventsTable.sport, MLB_SCOPE.sport),
    eq(eventsTable.competition, MLB_SCOPE.competition), eq(eventsTable.source, MLB_SCOPE.source),
  ));
  const teams = await database.select({ id: teamsTable.id, name: teamsTable.name })
    .from(teamsTable).where(eq(teamsTable.sport, "MLB"));
  const names = new Map(teams.map((t) => [t.id, t.name]));
  return rows.map((row) => {
    const data = row.sourceData;
    const round = data?.round;
    if (typeof round !== "string" || !(round in MLB_ROUNDS) || typeof data?.seriesKey !== "string" ||
        typeof data?.gameNumber !== "number" || typeof data?.sourceUrl !== "string" ||
        !names.has(row.homeTeamId) || !names.has(row.awayTeamId)) {
      throw new Error(`MLB canonical event ${row.id} has incomplete round/series provenance.`);
    }
    return {
      providerId: row.sourceEventId, seriesKey: data.seriesKey, round: round as MlbRound,
      gameNumber: data.gameNumber, homeTeamId: row.homeTeamId, awayTeamId: row.awayTeamId,
      homeName: names.get(row.homeTeamId)!, awayName: names.get(row.awayTeamId)!,
      scheduledAt: row.kickoffAt?.toISOString() ?? null, status: row.status,
      eventDate: row.eventDate,
      homeScore: row.homeScore, awayScore: row.awayScore, sourceUrl: data.sourceUrl,
    };
  });
}

export async function syncMlbEventsTx(tx: MlbTx, pool: MlbPool, payloads: EspnMlbPayload[]): Promise<number> {
  if (pool.sport !== "MLB" || pool.competitionFormat !== "MLB_POSTSEASON") throw new Error("MLB ingestion requires an explicit MLB postseason pool.");
  const entries = await tx.select({ id: calcuttaEntriesTable.id, teamId: teamsTable.id, name: teamsTable.name })
    .from(calcuttaEntriesTable).innerJoin(teamsTable, eq(teamsTable.id, calcuttaEntriesTable.teamId))
    .where(eq(calcuttaEntriesTable.calcuttaId, pool.id));
  if (entries.length !== 12) throw new Error("MLB results require a complete 12-team payout universe.");
  const parsedById = new Map<string, ReturnType<typeof parseEspnMlbPostseason>[number]>();
  const evidenceById = new Map<string, Array<{ sourceUrl: string; fetchedAt: string; raw: Record<string, unknown> }>>();
  const comparable = (game: ReturnType<typeof parseEspnMlbPostseason>[number]) => JSON.stringify({
    seriesKey: game.seriesKey, gameNumber: game.gameNumber, home: game.homeTeam.providerTeamId,
    away: game.awayTeam.providerTeamId, status: game.status, homeScore: game.homeScore,
    awayScore: game.awayScore, eventDate: game.eventDate, kickoffAt: game.kickoffAt,
  });
  for (const game of payloads.flatMap((p) => parseEspnMlbPostseason(p, pool.year))) {
    const prior = parsedById.get(game.providerEventId);
    if (prior && comparable(prior) !== comparable(game)) {
      // The same rescheduled game can occur on two daily pages. Its later
      // event date is explicit reschedule evidence, not a second played game.
      // Conflicting facts for the same date cannot be resolved by fetch order.
      if (prior.seriesKey !== game.seriesKey || prior.gameNumber !== game.gameNumber ||
          prior.eventDate === game.eventDate) throw new Error(`Conflicting ESPN MLB evidence for ${game.providerEventId}.`);
      if (prior.eventDate < game.eventDate) parsedById.set(game.providerEventId, game);
    } else parsedById.set(game.providerEventId, game);
    (evidenceById.get(game.providerEventId) ?? evidenceById.set(game.providerEventId, []).get(game.providerEventId)!).push({
      sourceUrl: game.sourceUrl, fetchedAt: game.sourceFetchedAt, raw: game.rawProviderData,
    });
  }
  for (const game of parsedById.values()) {
    const row = {
      seasonId: pool.seasonId, ...MLB_SCOPE, sourceEventId: game.providerEventId,
      week: game.period, eventDate: game.eventDate, kickoffAt: game.kickoffAt,
      timezone: "America/New_York", homeTeamId: resolveMlbParticipant(game.homeTeam, entries),
      awayTeamId: resolveMlbParticipant(game.awayTeam, entries),
      venue: game.venue, network: game.network, status: game.status,
      homeScore: game.homeScore, awayScore: game.awayScore,
      sourceData: {
        round: game.round, seriesKey: game.seriesKey, gameNumber: game.gameNumber,
        sourceUrl: game.sourceUrl, sourceFetchedAt: game.sourceFetchedAt,
        raw: game.rawProviderData,
        observedDailyEvidence: evidenceById.get(game.providerEventId)!,
      },
    };
    await tx.insert(eventsTable).values(row).onConflictDoUpdate({
      target: [eventsTable.seasonId, eventsTable.sport, eventsTable.competition, eventsTable.source, eventsTable.sourceEventId],
      set: row,
    });
  }
  // Never delete absent games based on an empty/partial daily response.
  await reconcileMlbCalendar(tx, pool, entries, await loadMlbGames(tx, pool.seasonId));
  return parsedById.size;
}

async function reconcileMlbCalendar(
  tx: MlbTx, pool: MlbPool,
  entries: Array<{ id: number; teamId: number; name: string }>, games: MlbGame[],
): Promise<void> {
  await tx.insert(calcuttaCalendarsTable).values({
    calcuttaId: pool.id, format: "mlb_series", scheduleState: "loaded",
  }).onConflictDoNothing({ target: calcuttaCalendarsTable.calcuttaId });
  const [calendar] = await tx.select().from(calcuttaCalendarsTable).where(eq(calcuttaCalendarsTable.calcuttaId, pool.id));
  if (!calendar || calendar.format !== "mlb_series") throw new Error("MLB pool has an incompatible calendar.");
  await tx.update(calcuttaCalendarsTable).set({ scheduleState: "loaded" }).where(eq(calcuttaCalendarsTable.id, calendar.id));
  await tx.insert(calendarParticipantsTable).values(entries.map((entry) => ({
    calendarId: calendar.id, teamId: entry.teamId,
  }))).onConflictDoNothing({ target: [calendarParticipantsTable.calendarId, calendarParticipantsTable.teamId] });
  const participants = await tx.select().from(calendarParticipantsTable).where(eq(calendarParticipantsTable.calendarId, calendar.id));
  const participantByTeam = new Map(participants.map((p) => [p.teamId, p.id]));
  const actualSeries = new Map<string, MlbGame[]>();
  for (const game of games) (actualSeries.get(game.seriesKey) ?? actualSeries.set(game.seriesKey, []).get(game.seriesKey)!).push(game);
  const winningSourceSlot = new Map<number, number>();
  for (const round of Object.keys(MLB_ROUNDS) as MlbRound[]) {
    const config = MLB_ROUNDS[round];
    await tx.insert(calendarRoundsTable).values({
      calendarId: calendar.id, sequence: config.sequence, name: round, kind: "best_of_series",
    }).onConflictDoNothing({ target: [calendarRoundsTable.calendarId, calendarRoundsTable.sequence] });
    const [roundRow] = await tx.select().from(calendarRoundsTable).where(and(
      eq(calendarRoundsTable.calendarId, calendar.id), eq(calendarRoundsTable.sequence, config.sequence),
    ));
    const keys = [...actualSeries.keys()].filter((key) => actualSeries.get(key)![0]!.round === round).sort();
    if (keys.length > config.seriesCount) throw new Error(`Too many MLB ${round} matchups.`);
    for (let number = 1; number <= config.seriesCount; number++) {
      await tx.insert(calendarSlotsTable).values({ roundId: roundRow!.id, slotNumber: number })
        .onConflictDoNothing({ target: [calendarSlotsTable.roundId, calendarSlotsTable.slotNumber] });
    }
    const slots = await tx.select().from(calendarSlotsTable).where(eq(calendarSlotsTable.roundId, roundRow!.id))
      .orderBy(asc(calendarSlotsTable.slotNumber));
    const candidates = slots.length ? await tx.select().from(calendarSlotCandidatesTable)
      .where(inArray(calendarSlotCandidatesTable.slotId, slots.map((slot) => Number(slot.id)))) : [];
    const teamByParticipant = new Map(participants.map((p) => [p.id, p.teamId]));
    const assignments = new Map<number, string>();
    const remaining = new Set(keys);
    for (const slot of slots) {
      const previousTeams = candidates.filter((c) => c.slotId === slot.id && c.participantId != null)
        .map((c) => teamByParticipant.get(c.participantId!)).sort((a, b) => (a ?? 0) - (b ?? 0));
      const key = keys.find((key) => {
        const first = actualSeries.get(key)![0]!;
        return JSON.stringify([first.homeTeamId, first.awayTeamId].sort((a, b) => a - b)) === JSON.stringify(previousTeams);
      });
      if (key && remaining.has(key)) { assignments.set(slot.id, key); remaining.delete(key); }
    }
    for (const key of [...remaining].sort()) {
      const slot = slots.find((slot) => !assignments.has(slot.id));
      if (!slot) throw new Error("MLB calendar has insufficient series slots.");
      assignments.set(slot.id, key);
    }
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      const seriesGames = (actualSeries.get(assignments.get(slot.id) ?? "") ?? []).sort((a, b) => a.gameNumber - b.gameNumber);
      const first = seriesGames[0];
      const existingSeries = await tx.select().from(calendarSeriesTable).where(eq(calendarSeriesTable.slotId, slot.id));
      if (!existingSeries.length) await tx.insert(calendarSeriesTable).values({ slotId: slot.id, bestOf: config.bestOf });
      else if (existingSeries.length !== 1 || existingSeries[0]!.bestOf !== config.bestOf) throw new Error("Conflicting MLB calendar series format.");
      await tx.delete(calendarSlotCandidatesTable).where(eq(calendarSlotCandidatesTable.slotId, slot.id));
      const sideIds = first ? [first.homeTeamId, first.awayTeamId] : [];
      const sourceSlots = sideIds.map((id) => winningSourceSlot.get(id) ?? null);
      await tx.update(calendarSlotsTable).set({
        homeSourceSlotId: sourceSlots[0] ?? null, awaySourceSlotId: sourceSlots[1] ?? null,
      }).where(eq(calendarSlotsTable.id, slot.id));
      if (first) await tx.insert(calendarSlotCandidatesTable).values(sideIds.map((id, side) => ({
        slotId: slot.id, participantId: participantByTeam.get(id)!, designation: side === 0 ? "home" : "away",
      })));
      for (let gameNumber = 1; gameNumber <= config.bestOf; gameNumber++) {
        const game = seriesGames.find((g) => g.gameNumber === gameNumber);
        const row = {
          slotId: slot.id, gameNumber,
          homeParticipantId: game ? participantByTeam.get(game.homeTeamId)! : null,
          awayParticipantId: game ? participantByTeam.get(game.awayTeamId)! : null,
        };
        await tx.insert(calendarGamesTable).values(row).onConflictDoUpdate({
          target: [calendarGamesTable.slotId, calendarGamesTable.gameNumber], set: row,
        });
      }
      const calendarGames = await tx.select().from(calendarGamesTable).where(eq(calendarGamesTable.slotId, slot.id));
      if (calendarGames.length) await tx.delete(calendarContingentGamesTable).where(inArray(
        calendarContingentGamesTable.gameId, calendarGames.map((g) => g.id),
      ));
      const contingencies = calendarGames.flatMap((game) => sourceSlots.filter((id): id is number => id != null).map((sourceSlotId) => ({
        gameId: game.id, prerequisiteSlotId: sourceSlotId, outcome: "advance",
      })));
      if (contingencies.length) await tx.insert(calendarContingentGamesTable).values(contingencies).onConflictDoNothing();
      const wins = new Map<number, number>();
      let expectedNumber = 1;
      for (const game of seriesGames) {
        if (game.status !== "final" || game.gameNumber !== expectedNumber || game.homeScore == null ||
            game.awayScore == null || game.homeScore === game.awayScore) break;
        expectedNumber++;
        const winner = game.homeScore > game.awayScore ? game.homeTeamId : game.awayTeamId;
        wins.set(winner, (wins.get(winner) ?? 0) + 1);
        if (wins.get(winner) === (config.bestOf + 1) / 2) {
          winningSourceSlot.set(winner, slot.id);
          break;
        }
      }
    }
  }
}
