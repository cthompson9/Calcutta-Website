import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { GetCalendarsResponse } from "@workspace/api-zod";

const canRun = Boolean(process.env.DATABASE_URL);
let app, db, runDatabaseMigrations;
let seasonsTable, calcuttasTable, calcuttaEntriesTable, teamsTable, mtmSnapshotTable;
let calcuttaCalendarsTable, calendarParticipantsTable, calendarRoundsTable, calendarSlotsTable;
let calendarSlotCandidatesTable, calendarSeriesTable, calendarGamesTable, calendarContingentGamesTable;
let calendarProjectionSnapshotsTable, calendarProjectionCandidatesTable;

if (canRun) {
  ({
    db, runDatabaseMigrations, seasonsTable, calcuttasTable, calcuttaEntriesTable, teamsTable,
    mtmSnapshotTable, calcuttaCalendarsTable, calendarParticipantsTable, calendarRoundsTable,
    calendarSlotsTable, calendarSlotCandidatesTable, calendarSeriesTable, calendarGamesTable,
    calendarContingentGamesTable, calendarProjectionSnapshotsTable, calendarProjectionCandidatesTable,
  } = await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
}

function startServer(expressApp) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function mcpCall(baseUrl, id, name, arguments_ = {}) {
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", Authorization: `Bearer ${process.env.MCP_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const json = body.trim().startsWith("event:") ? body.split("\n").find((line) => line.startsWith("data: "))?.slice(6) : body;
  return JSON.parse(JSON.parse(json).result.content.find((item) => item.type === "text").text);
}

describe("Calcutta calendar REST/MCP integration", { skip: !canRun }, () => {
  let server, baseUrl, season, calcutta, seriesCalcutta, calendar, seriesCalendar, teams, participants, slots, snapshot, initialProjection;
  let firstRound, seriesSourceSlot;

  before(async () => {
    await runDatabaseMigrations();
    const fixture = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    [teams] = [await db.select().from(teamsTable).limit(4)];
    assert.equal(teams.length, 4);
    [season] = await db.insert(seasonsTable).values({ year: 9000 + Date.now() % 500, label: `calendar integration ${fixture}`, isActive: false, isComplete: false }).returning();
    [calcutta, seriesCalcutta] = await db.insert(calcuttasTable).values([
      { seasonId: season.id, year: season.year, name: `NFL calendar ${fixture}`, sport: "NFL", isCanonical: true },
      { seasonId: season.id, year: season.year, name: `MLB calendar ${fixture}`, sport: "MLB", isCanonical: false },
    ]).returning();
    await db.insert(calcuttaEntriesTable).values(teams.map((team) => ({ calcuttaId: calcutta.id, teamId: team.id })));
    await db.insert(calcuttaEntriesTable).values({ calcuttaId: seriesCalcutta.id, teamId: teams[0].id });
    [calendar, seriesCalendar] = await db.insert(calcuttaCalendarsTable).values([
      { calcuttaId: calcutta.id, format: "nfl_single_elimination", scheduleState: "loaded" },
      { calcuttaId: seriesCalcutta.id, format: "mlb_series", scheduleState: "not_applicable", scheduleAbsentReason: "Schedule is supplied by the league after the auction." },
    ]).returning();
    participants = await db.insert(calendarParticipantsTable).values(teams.map((team, index) => ({
      calendarId: calendar.id, teamId: team.id, seed: index + 1, designation: index === 0 ? "home" : index === 1 ? "away" : null,
    }))).returning();
    [firstRound] = await db.insert(calendarRoundsTable).values({ calendarId: calendar.id, sequence: 1, name: "Quarterfinal", kind: "elimination" }).returning();
    const [roundTwo] = await db.insert(calendarRoundsTable).values({ calendarId: calendar.id, sequence: 2, name: "Final", kind: "elimination" }).returning();
    const firstRoundSlots = await db.insert(calendarSlotsTable).values([
      { roundId: firstRound.id, slotNumber: 1 }, { roundId: firstRound.id, slotNumber: 2 },
    ]).returning();
    const [finalSlot] = await db.insert(calendarSlotsTable).values({
      roundId: roundTwo.id, slotNumber: 1, homeSourceSlotId: firstRoundSlots[0].id, awaySourceSlotId: firstRoundSlots[1].id,
    }).returning();
    slots = [...firstRoundSlots, finalSlot];
    await db.insert(calendarSlotCandidatesTable).values([
      { slotId: slots[0].id, participantId: participants[0].id, seed: 1, designation: "home" },
      { slotId: slots[0].id, participantId: participants[1].id, seed: 2, designation: "away" },
      { slotId: slots[1].id, participantId: participants[2].id, seed: 3, designation: "home" },
      { slotId: slots[1].id, participantId: participants[3].id, seed: 4, designation: "away" },
      { slotId: slots[2].id, sourceSlotId: slots[0].id }, { slotId: slots[2].id, sourceSlotId: slots[1].id },
    ]);
    await db.insert(calendarSeriesTable).values({ slotId: slots[0].id, bestOf: 3 });
    const games = await db.insert(calendarGamesTable).values([
      { slotId: slots[0].id, gameNumber: 1, homeParticipantId: participants[0].id, awayParticipantId: participants[1].id, neutralSite: true },
      { slotId: slots[0].id, gameNumber: 2, homeParticipantId: participants[0].id, awayParticipantId: participants[1].id, neutralSite: true },
      { slotId: slots[2].id, gameNumber: 1, neutralSite: false },
    ]).returning();
    await db.insert(calendarContingentGamesTable).values({ gameId: games[2].id, prerequisiteSlotId: slots[0].id, outcome: "winner" });
    const [seriesRound] = await db.insert(calendarRoundsTable).values({
      calendarId: seriesCalendar.id, sequence: 1, name: "Series", kind: "series",
    }).returning();
    [seriesSourceSlot] = await db.insert(calendarSlotsTable).values({
      roundId: seriesRound.id, slotNumber: 1,
    }).returning();
    [snapshot] = await db.insert(mtmSnapshotTable).values({
      poolId: calcutta.id, asOf: new Date("2099-01-01T00:00:00Z"), asOfHour: new Date("2099-01-01T00:00:00Z"),
      trigger: "manual", status: "ok", methodVersion: "calendar-test", stateJson: {}, inputProvenance: {},
    }).returning();
    await db.transaction(async (tx) => {
      const [projection] = await tx.insert(calendarProjectionSnapshotsTable).values({
        slotId: slots[0].id, mtmSnapshotId: snapshot.id, status: "available",
      }).returning();
      initialProjection = projection;
      await tx.insert(calendarProjectionCandidatesTable).values([
        { projectionId: projection.id, participantId: participants[0].id, probability: "0.000000", exactSlotClinched: false },
        { projectionId: projection.id, participantId: participants[1].id, probability: "1.000000", exactSlotClinched: true },
      ]);
    });
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    // Always close the server first, but do not let a close error prevent
    // fixture cleanup.  In particular, a failed test must not leave its MLB
    // Calcutta in the global catalog for normalizedHistorical.test.mjs.
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      if (!db || !season) return;
      const calcuttaIds = (await db.select({ id: calcuttasTable.id }).from(calcuttasTable)
        .where(eq(calcuttasTable.seasonId, season.id))).map((row) => row.id);
      const calendarIds = calcuttaIds.length
        ? (await db.select({ id: calcuttaCalendarsTable.id }).from(calcuttaCalendarsTable)
          .where(inArray(calcuttaCalendarsTable.calcuttaId, calcuttaIds))).map((row) => row.id)
        : [];
      const slotIds = calendarIds.length
        ? (await db.select({ id: calendarSlotsTable.id }).from(calendarSlotsTable)
          .innerJoin(calendarRoundsTable, eq(calendarRoundsTable.id, calendarSlotsTable.roundId))
          .where(inArray(calendarRoundsTable.calendarId, calendarIds))).map((row) => row.id)
        : [];
      // Projection snapshots reference MTM snapshots without cascade. Remove
      // every dependent row explicitly, in FK-safe order, before parents.
      if (slotIds.length) {
        const projectionIds = (await db.select({ id: calendarProjectionSnapshotsTable.id }).from(calendarProjectionSnapshotsTable)
          .where(inArray(calendarProjectionSnapshotsTable.slotId, slotIds))).map((row) => row.id);
        if (projectionIds.length) await db.delete(calendarProjectionSnapshotsTable).where(inArray(calendarProjectionSnapshotsTable.id, projectionIds));
        const gameIds = (await db.select({ id: calendarGamesTable.id }).from(calendarGamesTable)
          .where(inArray(calendarGamesTable.slotId, slotIds))).map((row) => row.id);
        if (gameIds.length) await db.delete(calendarContingentGamesTable).where(inArray(calendarContingentGamesTable.gameId, gameIds));
        if (gameIds.length) await db.delete(calendarGamesTable).where(inArray(calendarGamesTable.id, gameIds));
      }
      // The remaining calendar children cascade from calendars, and calendar
      // entries cascade from the Calcutta.  Delete snapshots before Calcuttas
      // because their projection FK is intentionally non-cascading.
      if (calcuttaIds.length) await db.delete(mtmSnapshotTable).where(inArray(mtmSnapshotTable.poolId, calcuttaIds));
      if (calcuttaIds.length) await db.delete(calcuttasTable).where(inArray(calcuttasTable.id, calcuttaIds));
      await db.delete(seasonsTable).where(eq(seasonsTable.id, season.id));
    }
  });

  test("parses both public calendar routes through generated schemas and preserves bracket details", async () => {
    const response = await fetch(`${baseUrl}/api/calendars?calcuttaId=${calcutta.id}`);
    assert.equal(response.status, 200);
    const payload = GetCalendarsResponse.parse(await response.json());
    assert.equal(payload.length, 1);
    const slot = payload[0].rounds[0].slots[0];
    assert.equal(slot.home.seed, 1);
    assert.equal(slot.home.designation, "home");
    assert.equal(slot.games.length, 2);
    assert.deepEqual(slot.games.map((game) => game.gameNumber), [1, 2]);
    assert.equal(slot.games[0].neutralSite, true);
    assert.deepEqual(slot.projection.candidates.map((candidate) => candidate.probability), [1, 0]);
    assert.equal(slot.projection.candidates[0].exactSlotClinched, true);
    assert.equal(slot.projection.candidates[1].exactSlotClinched, false);
    const direct = GetCalendarsResponse.element.parse(await (await fetch(`${baseUrl}/api/calendars/${calendar.id}`)).json());
    assert.equal(direct.id, calendar.id);
    assert.equal(direct.rounds[1].slots[0].games[0].contingent[0].outcome, "winner");
    assert.equal(direct.rounds[1].slots[0].home.sourceSlotId, slots[0].id);
    assert.equal(direct.rounds[1].slots[0].away.sourceSlotId, slots[1].id);
    assert.notEqual(direct.rounds[1].slots[0].home.sourceSlotId, direct.rounds[1].slots[0].away.sourceSlotId);
  });

  test("distinguishes not_applicable reason from not_loaded", async () => {
    const response = await fetch(`${baseUrl}/api/calendars?calcuttaId=${seriesCalcutta.id}`);
    const [payload] = GetCalendarsResponse.parse(await response.json());
    assert.equal(payload.scheduleState, "not_applicable");
    assert.match(payload.scheduleAbsentReason, /league/i);
    const [pending] = await db.insert(calcuttasTable).values({ seasonId: season.id, year: season.year, name: `pending-${Date.now()}`, sport: "NFL", isCanonical: false }).returning();
    const [pendingCalendar] = await db.insert(calcuttaCalendarsTable).values({ calcuttaId: pending.id, format: "nfl_single_elimination" }).returning();
    const pendingPayload = GetCalendarsResponse.element.parse(await (await fetch(`${baseUrl}/api/calendars/${pendingCalendar.id}`)).json());
    assert.equal(pendingPayload.scheduleState, "not_loaded");
    assert.equal(pendingPayload.scheduleAbsentReason, null);
  });

  test("rejects fractional and non-positive calendar identifiers", async () => {
    for (const url of [
      `${baseUrl}/api/calendars/1.5`,
      `${baseUrl}/api/calendars/0`,
      `${baseUrl}/api/calendars?calcuttaId=1.5`,
      `${baseUrl}/api/calendars?calcuttaId=0`,
    ]) {
      const response = await fetch(url);
      assert.equal(response.status, 400, url);
    }
  });

  test("MCP calendar tools have the same read semantics", async (t) => {
    if (!process.env.MCP_API_KEY) return t.skip("MCP key unavailable");
    const full = await mcpCall(baseUrl, 1, "get_calcutta_calendar", { calendarId: calendar.id });
    const projection = await mcpCall(baseUrl, 2, "get_current_bracket_projection", { calendarId: calendar.id });
    assert.equal(full.id, calendar.id);
    assert.deepEqual(projection.currentProjection, full.currentProjection);
    assert.deepEqual(projection.rounds, full.rounds);
  });

  test("database rejects failed-snapshot and cross-calendar projections", async () => {
    const [failed] = await db.insert(mtmSnapshotTable).values({
      poolId: calcutta.id, asOf: new Date("2099-01-02T00:00:00Z"), asOfHour: new Date("2099-01-02T00:00:00Z"),
      trigger: "manual", status: "failed", methodVersion: "calendar-test", stateJson: {}, inputProvenance: {},
    }).returning();
    await assert.rejects(() => db.insert(calendarProjectionSnapshotsTable).values({ slotId: slots[0].id, mtmSnapshotId: failed.id, status: "unavailable", unavailableReason: "failed" }));
    await assert.rejects(() => db.insert(calendarProjectionCandidatesTable).values({ projectionId: 999999999, participantId: participants[0].id, probability: "1" }));
  });

  test("database continuously enforces topology and projection-set integrity", async () => {
    await assert.rejects(() => db.insert(calendarSlotsTable).values({
      roundId: firstRound.id, slotNumber: 99, homeSourceSlotId: 999999999,
    }));
    await assert.rejects(() => db.insert(calendarSlotsTable).values({
      roundId: firstRound.id, slotNumber: 99, homeSourceSlotId: seriesSourceSlot.id,
    }));
    await assert.rejects(() => db.delete(calcuttaEntriesTable).where(and(
      eq(calcuttaEntriesTable.calcuttaId, calcutta.id),
      eq(calcuttaEntriesTable.teamId, teams[0].id),
    )));
    await assert.rejects(() => db.update(calcuttaCalendarsTable)
      .set({ calcuttaId: seriesCalcutta.id }).where(eq(calcuttaCalendarsTable.id, calendar.id)));
    await assert.rejects(() => db.update(calendarRoundsTable)
      .set({ calendarId: seriesCalendar.id }).where(eq(calendarRoundsTable.id, firstRound.id)));
    await assert.rejects(() => db.update(mtmSnapshotTable)
      .set({ status: "failed" }).where(eq(mtmSnapshotTable.id, snapshot.id)));
    await assert.rejects(() => db.update(mtmSnapshotTable)
      .set({ poolId: seriesCalcutta.id }).where(eq(mtmSnapshotTable.id, snapshot.id)));

    const insertProjectionSet = (status, reason, candidates) => db.transaction(async (tx) => {
      const [projection] = await tx.insert(calendarProjectionSnapshotsTable).values({
        slotId: slots[1].id,
        mtmSnapshotId: snapshot.id,
        status,
        unavailableReason: reason,
      }).returning();
      if (candidates.length) {
        await tx.insert(calendarProjectionCandidatesTable).values(
          candidates.map((candidate) => ({ ...candidate, projectionId: projection.id })),
        );
      }
      return projection;
    });

    await assert.rejects(() => insertProjectionSet("available", null, []));
    await assert.rejects(() => insertProjectionSet("available", null, [
      { participantId: participants[2].id, probability: "0.400000", exactSlotClinched: false },
      { participantId: participants[3].id, probability: "0.500000", exactSlotClinched: false },
    ]));
    await assert.rejects(() => insertProjectionSet("available", null, [
      { participantId: participants[2].id, probability: "1.000000", exactSlotClinched: true },
      { participantId: participants[3].id, probability: "1.000000", exactSlotClinched: true },
    ]));
    await assert.rejects(() => insertProjectionSet("unavailable", "not modeled", [
      { participantId: participants[2].id, probability: "1.000000", exactSlotClinched: true },
    ]));

    const projection = await insertProjectionSet("available", null, [
      { participantId: participants[2].id, probability: "0.400000", exactSlotClinched: false },
      { participantId: participants[3].id, probability: "0.600000", exactSlotClinched: false },
    ]);
    try {
      const [candidate] = await db.select().from(calendarProjectionCandidatesTable)
        .where(eq(calendarProjectionCandidatesTable.projectionId, projection.id))
        .limit(1);
      await assert.rejects(() => db.update(calendarProjectionCandidatesTable)
        .set({ projectionId: initialProjection.id })
        .where(eq(calendarProjectionCandidatesTable.id, candidate.id)));
      await assert.rejects(() => db.update(calendarProjectionCandidatesTable)
        .set({ participantId: participants[0].id })
        .where(eq(calendarProjectionCandidatesTable.id, candidate.id)));
      await assert.rejects(() => db.transaction(async (tx) => {
        await tx.update(calendarProjectionSnapshotsTable)
          .set({ status: "unavailable", unavailableReason: "withdrawn" })
          .where(eq(calendarProjectionSnapshotsTable.id, projection.id));
      }));
    } finally {
      await db.delete(calendarProjectionSnapshotsTable)
        .where(eq(calendarProjectionSnapshotsTable.id, projection.id));
    }
  });

  test("never presents an older projection as current", async () => {
    const newerAt = new Date("2099-01-03T00:00:00Z");
    const [newer] = await db.insert(mtmSnapshotTable).values({
      poolId: calcutta.id, asOf: newerAt, asOfHour: newerAt,
      trigger: "manual", status: "ok", methodVersion: "calendar-test", stateJson: {}, inputProvenance: {},
    }).returning();
    try {
      const payload = GetCalendarsResponse.element.parse(
        await (await fetch(`${baseUrl}/api/calendars/${calendar.id}`)).json(),
      );
      assert.equal(payload.currentProjection.mtmSnapshotId, newer.id);
      assert.equal(payload.currentProjection.status, "unavailable");
      assert.match(payload.currentProjection.reason, /current successful MTM snapshot/i);
      assert.ok(payload.rounds.every((round) =>
        round.slots.every((slot) => slot.projection === null),
      ));
    } finally {
      await db.delete(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, newer.id));
    }
  });

  test("fails calendar projections closed after a failed or stale MTM attempt", async () => {
    const failedAt = new Date("2100-01-01T00:00:00Z");
    const [failed] = await db.insert(mtmSnapshotTable).values({
      poolId: calcutta.id, asOf: failedAt, asOfHour: failedAt, createdAt: failedAt,
      trigger: "manual", status: "failed", error: "calendar test refresh failed",
      methodVersion: "calendar-test", stateJson: {}, inputProvenance: {},
    }).returning();
    try {
      const failedPayload = GetCalendarsResponse.element.parse(
        await (await fetch(`${baseUrl}/api/calendars/${calendar.id}`)).json(),
      );
      assert.equal(failedPayload.currentProjection.status, "unavailable");
      assert.match(failedPayload.currentProjection.reason, /calendar test refresh failed/i);
      assert.ok(failedPayload.rounds.every((round) =>
        round.slots.every((slot) => slot.projection === null),
      ));
    } finally {
      await db.delete(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, failed.id));
    }

    const originalAsOf = snapshot.asOf;
    await db.update(mtmSnapshotTable)
      .set({ asOf: new Date("2000-01-01T00:00:00Z") })
      .where(eq(mtmSnapshotTable.id, snapshot.id));
    try {
      const stalePayload = GetCalendarsResponse.element.parse(
        await (await fetch(`${baseUrl}/api/calendars/${calendar.id}`)).json(),
      );
      assert.equal(stalePayload.currentProjection.status, "unavailable");
      assert.match(stalePayload.currentProjection.reason, /hours old/i);
      assert.ok(stalePayload.rounds.every((round) =>
        round.slots.every((slot) => slot.projection === null),
      ));
    } finally {
      await db.update(mtmSnapshotTable)
        .set({ asOf: originalAsOf })
        .where(eq(mtmSnapshotTable.id, snapshot.id));
    }
  });
});