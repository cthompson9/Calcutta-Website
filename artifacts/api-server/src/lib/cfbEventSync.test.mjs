import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  eventsTable,
  runDatabaseMigrations,
  seasonsTable,
  teamsTable,
} from "@workspace/db";
import {
  parseEspnCfbEvents,
  syncCfbEventsTx,
  validateEspnCfbEvents,
} from "./cfbEventSync.ts";
import {
  CFB_REGULAR_SEASON,
  CFB_SPORT,
  NFL_REGULAR_SEASON,
  NFL_SPORT,
  eventScopeKey,
} from "./eventIngestion.ts";

function cfbEvent(overrides = {}) {
  return {
    id: "shared-provider-id",
    date: "2026-09-05T23:30:00Z",
    season: { year: 2026, type: 2 },
    week: { number: 1 },
    status: { type: { state: "post", completed: true, name: "STATUS_FINAL" } },
    competitions: [{
      date: "2026-09-05T23:30:00Z",
      timeValid: true,
      venue: { fullName: "Test Stadium" },
      broadcasts: [{ names: ["ESPN"] }],
      competitors: [
        {
          homeAway: "home",
          score: "31",
          team: {
            id: "cfb-home",
            abbreviation: "UGA",
            displayName: "Georgia Bulldogs",
            location: "Georgia",
          },
        },
        {
          homeAway: "away",
          score: "24",
          team: {
            id: "cfb-away",
            abbreviation: "ALA",
            displayName: "Alabama Crimson Tide",
            location: "Alabama",
          },
        },
      ],
    }],
    ...overrides,
  };
}

test("the ESPN CFB adapter preserves provider identities, aliases, and raw data", () => {
  const source = cfbEvent();
  const [parsed] = parseEspnCfbEvents({ events: [source] }, 2026);
  assert.equal(parsed.sport, CFB_SPORT);
  assert.equal(parsed.competition, CFB_REGULAR_SEASON);
  assert.equal(parsed.providerEventId, "shared-provider-id");
  assert.equal(parsed.homeTeam.providerTeamId, "cfb-home");
  assert.equal(parsed.homeTeam.canonicalName, "Georgia");
  assert.ok(parsed.homeTeam.aliases.includes("Georgia Bulldogs"));
  assert.equal(parsed.status, "final");
  assert.equal(parsed.homeScore, 31);
  assert.deepEqual(parsed.rawProviderData, source);
});

test("CFB validation is separate from NFL counts and rejects unsafe payloads", () => {
  assert.equal(validateEspnCfbEvents({ events: [cfbEvent()] }, 2026).length, 1);
  assert.throws(
    () => validateEspnCfbEvents({ events: [cfbEvent(), cfbEvent()] }, 2026),
    /duplicate CFB event IDs/,
  );
  assert.throws(
    () => validateEspnCfbEvents({ events: [] }, 2026),
    /no regular-season CFB events/,
  );
});

test("NFL and CFB scopes remain distinct for the same season and provider ID", () => {
  assert.notEqual(
    eventScopeKey({
      sport: NFL_SPORT,
      competition: NFL_REGULAR_SEASON,
      seasonYear: 2026,
    }),
    eventScopeKey({
      sport: CFB_SPORT,
      competition: CFB_REGULAR_SEASON,
      seasonYear: 2026,
    }),
  );
});

test(
  "retries and corrected CFB payloads are idempotent without touching an overlapping NFL event",
  { skip: !process.env.DATABASE_URL },
  async () => {
    await runDatabaseMigrations();
    const rollback = new Error("rollback test transaction");
    await assert.rejects(
      db.transaction(async (tx) => {
        const [season] = await tx.insert(seasonsTable).values({
          year: 2198,
          label: "2198 event isolation test",
        }).returning({ id: seasonsTable.id });
        const localTeams = await tx.select({ id: teamsTable.id }).from(teamsTable).limit(2);
        assert.equal(localTeams.length, 2);
        await tx.insert(eventsTable).values({
          seasonId: season.id,
          sport: NFL_SPORT,
          competition: NFL_REGULAR_SEASON,
          source: "espn",
          sourceEventId: "shared-provider-id",
          week: 1,
          eventDate: "2198-09-01",
          awayTeamId: localTeams[0].id,
          homeTeamId: localTeams[1].id,
          status: "scheduled",
        });

        const payload = {
          events: [cfbEvent({
            date: "2198-09-05T23:30:00Z",
            season: { year: 2198, type: 2 },
            competitions: [{
              ...cfbEvent().competitions[0],
              date: "2198-09-05T23:30:00Z",
            }],
          })],
        };
        assert.deepEqual(
          await syncCfbEventsTx(tx, season.id, 2198, payload),
          { eventsUpserted: 1 },
        );
        assert.deepEqual(
          await syncCfbEventsTx(tx, season.id, 2198, payload),
          { eventsUpserted: 1 },
        );

        const corrected = structuredClone(payload);
        corrected.events[0].competitions[0].competitors[0].score = "34";
        await syncCfbEventsTx(tx, season.id, 2198, corrected);

        const rows = await tx.select().from(eventsTable).where(and(
          eq(eventsTable.seasonId, season.id),
          eq(eventsTable.sourceEventId, "shared-provider-id"),
        ));
        assert.equal(rows.length, 2);
        assert.equal(rows.find((row) => row.sport === NFL_SPORT)?.homeScore, null);
        assert.equal(rows.find((row) => row.sport === CFB_SPORT)?.homeScore, 34);
        throw rollback;
      }),
      (error) => error === rollback,
    );
  },
);