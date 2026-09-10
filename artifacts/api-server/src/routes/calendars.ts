import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db,
  calcuttaCalendarsTable,
  calendarParticipantsTable,
  calendarRoundsTable,
  calendarSlotsTable,
  calendarSlotCandidatesTable,
  calendarSeriesTable,
  calendarGamesTable,
  calendarContingentGamesTable,
  calendarProjectionSnapshotsTable,
  calendarProjectionCandidatesTable,
  calendarPoolEconomicsTable,
  calendarRubricValuesTable,
  calcuttasTable,
  teamsTable,
  mtmSnapshotTable,
} from "@workspace/db";
import { GetCalendarParams, GetCalendarResponse, GetCalendarsQueryParams, GetCalendarsResponse } from "@workspace/api-zod";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import { getMtmPipelineStatus } from "../lib/mtmPipeline";

const router: IRouter = Router();

export async function readCalendar(id: number) {
  const calendar = (await db.select().from(calcuttaCalendarsTable).where(eq(calcuttaCalendarsTable.id, id)).limit(1))[0];
  if (!calendar) return null;
  const pool = (await db.select({ year: calcuttasTable.year })
    .from(calcuttasTable)
    .where(eq(calcuttasTable.id, calendar.calcuttaId))
    .limit(1))[0];
  const pipelineStatus = pool
    ? await getMtmPipelineStatus(pool.year, calendar.calcuttaId)
    : null;
  const authoritativeSnapshotId = pipelineStatus && !pipelineStatus.stale
    ? pipelineStatus.currentSnapshotId
    : null;
  const [participants, rounds, slots, candidates, series, games, contingentGames, economics, rubric, current, projectionCandidates] = await Promise.all([
    db.select({ id: calendarParticipantsTable.id, teamId: calendarParticipantsTable.teamId, teamName: teamsTable.name, seed: calendarParticipantsTable.seed, designation: calendarParticipantsTable.designation }).from(calendarParticipantsTable).innerJoin(teamsTable, eq(teamsTable.id, calendarParticipantsTable.teamId)).where(eq(calendarParticipantsTable.calendarId, id)),
    db.select().from(calendarRoundsTable).where(eq(calendarRoundsTable.calendarId, id)).orderBy(asc(calendarRoundsTable.sequence)),
    db.select().from(calendarSlotsTable).innerJoin(calendarRoundsTable, eq(calendarRoundsTable.id, calendarSlotsTable.roundId)).where(eq(calendarRoundsTable.calendarId, id)).orderBy(asc(calendarRoundsTable.sequence), asc(calendarSlotsTable.slotNumber)),
    db.select().from(calendarSlotCandidatesTable),
    db.select().from(calendarSeriesTable),
    db.select().from(calendarGamesTable).orderBy(
      asc(calendarGamesTable.slotId),
      asc(calendarGamesTable.gameNumber),
      asc(calendarGamesTable.id),
    ),
    db.select().from(calendarContingentGamesTable),
    db.select().from(calendarPoolEconomicsTable).where(eq(calendarPoolEconomicsTable.calendarId, id)),
    db.select().from(calendarRubricValuesTable).where(eq(calendarRubricValuesTable.calendarId, id)),
    db.select({ snapshot: calendarProjectionSnapshotsTable, mtmStatus: mtmSnapshotTable.status })
      .from(calendarProjectionSnapshotsTable)
      .innerJoin(mtmSnapshotTable, eq(mtmSnapshotTable.id, calendarProjectionSnapshotsTable.mtmSnapshotId))
      .where(and(eq(mtmSnapshotTable.id, authoritativeSnapshotId ?? -1), eq(mtmSnapshotTable.status, "ok")))
      .orderBy(desc(mtmSnapshotTable.asOf), desc(calendarProjectionSnapshotsTable.id)),
    db.select({ projectionId: calendarProjectionCandidatesTable.projectionId, participantId: calendarProjectionCandidatesTable.participantId, probability: calendarProjectionCandidatesTable.probability, exactSlotClinched: calendarProjectionCandidatesTable.exactSlotClinched, teamName: teamsTable.name })
      .from(calendarProjectionCandidatesTable).innerJoin(calendarParticipantsTable, eq(calendarParticipantsTable.id, calendarProjectionCandidatesTable.participantId)).innerJoin(teamsTable, eq(teamsTable.id, calendarParticipantsTable.teamId)),
  ]);
  const currentBySlot = new Map<number, typeof current[number]["snapshot"]>();
  for (const row of current) if (!currentBySlot.has(row.snapshot.slotId)) currentBySlot.set(row.snapshot.slotId, row.snapshot);
  const projectionCandidatesByProjection = new Map<number, typeof projectionCandidates>();
  for (const row of projectionCandidates) (projectionCandidatesByProjection.get(row.projectionId) ?? projectionCandidatesByProjection.set(row.projectionId, []).get(row.projectionId)!).push(row);
  const gamesBySlot = new Map<number, typeof games>();
  for (const row of games) (gamesBySlot.get(row.slotId) ?? gamesBySlot.set(row.slotId, []).get(row.slotId)!).push(row);
  const seriesBySlot = new Map(series.map((row) => [row.slotId, row]));
  const roundsOut = rounds.map((round) => ({
    id: round.id, sequence: round.sequence, name: round.name, kind: round.kind,
    slots: slots.filter(({ calendar_slots: slot }) => slot.roundId === round.id).map(({ calendar_slots: slot }) => {
      const slotCandidates = candidates.filter((candidate) => candidate.slotId === slot.id);
      const side = (designation: "home" | "away") => {
        const sourceSlotId = designation === "home" ? slot.homeSourceSlotId : slot.awaySourceSlotId;
        const candidate = slotCandidates.find((item) => item.designation === designation && item.participantId != null)
          ?? (sourceSlotId == null ? undefined : slotCandidates.find((item) => item.sourceSlotId === sourceSlotId));
        return candidate ? { participantId: candidate.participantId, sourceSlotId: candidate.sourceSlotId, seed: candidate.seed, designation: candidate.designation } : null;
      };
      const home = side("home");
      const away = side("away");
      if (home?.sourceSlotId != null && home.sourceSlotId === away?.sourceSlotId) {
        throw new Error(`Calendar slot ${slot.id} has identical home and away source slots.`);
      }
      const projection = currentBySlot.get(slot.id);
      return {
        id: slot.id, slotNumber: slot.slotNumber, home, away,
        seriesBestOf: seriesBySlot.get(slot.id)?.bestOf ?? null,
        games: (gamesBySlot.get(slot.id) ?? []).map((game) => ({ id: game.id, gameNumber: game.gameNumber, neutralSite: game.neutralSite, homeParticipantId: game.homeParticipantId, awayParticipantId: game.awayParticipantId, contingent: contingentGames.filter((item) => item.gameId === game.id).map((item) => ({ prerequisiteSlotId: item.prerequisiteSlotId, outcome: item.outcome })) })),
        projection: projection ? {
          status: projection.status,
          reason: projection.unavailableReason,
          candidates: (projectionCandidatesByProjection.get(projection.id) ?? [])
            .sort((a, b) => Number(b.probability) - Number(a.probability))
            .map((candidate) => ({ participantId: candidate.participantId, teamName: candidate.teamName, probability: Number(candidate.probability), exactSlotClinched: candidate.exactSlotClinched })),
        } : null,
      };
    }),
  }));
  return {
    id: calendar.id, calcuttaId: calendar.calcuttaId, format: calendar.format,
    scheduleState: calendar.scheduleState, scheduleAbsentReason: calendar.scheduleAbsentReason,
    participants, rounds: roundsOut,
    economics: economics.map((row) => ({ key: row.key, value: Number(row.value) })),
    rubric: rubric.map((row) => ({ label: row.label, points: Number(row.points) })),
    currentProjection: pipelineStatus
      ? {
          mtmSnapshotId: pipelineStatus.currentSnapshotId ?? pipelineStatus.id,
          status: pipelineStatus.stale
            ? "unavailable"
            : (current[0]?.snapshot.status ?? "unavailable"),
          reason: pipelineStatus.stale
            ? pipelineStatus.staleReasons.join(" ")
            : (current[0]?.snapshot.unavailableReason ?? "No calendar projection was published for the current successful MTM snapshot."),
        }
      : null,
  };
}

router.get("/calendars", async (req, res, next) => {
  try {
    const parsed = GetCalendarsQueryParams.safeParse(req.query);
    if (!parsed.success) { sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400); return; }
    const rows = await db.select({ id: calcuttaCalendarsTable.id })
      .from(calcuttaCalendarsTable)
      .where(parsed.data.calcuttaId == null ? undefined : eq(calcuttaCalendarsTable.calcuttaId, parsed.data.calcuttaId))
      .orderBy(desc(calcuttaCalendarsTable.id));
    const calendars = (await Promise.all(rows.map((row) => readCalendar(row.id)))).filter((row): row is NonNullable<typeof row> => row != null);
    sendParsedJson(res, GetCalendarsResponse, calendars);
  } catch (error) { next(error); }
});

router.get("/calendars/:id", async (req, res, next) => {
  try {
    const parsedParams = GetCalendarParams.safeParse(req.params);
    if (!parsedParams.success) { sendParsedJson(res, ErrorResponse, { error: parsedParams.error.message }, 400); return; }
    const id = parsedParams.data.id;
    const calendar = await readCalendar(id);
    if (!calendar) { sendParsedJson(res, ErrorResponse, { error: "Calendar not found" }, 404); return; }
    sendParsedJson(res, GetCalendarResponse, calendar);
  } catch (error) { next(error); }
});

export default router;