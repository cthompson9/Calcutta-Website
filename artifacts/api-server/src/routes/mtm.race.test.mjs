/**
 * Integration tests: manual MTM entry vs. Week 0 capture conflict protection.
 *
 * Exercises both write paths (POST /api/mtm and POST /api/mtm/week-zero/capture)
 * against a live database to prove:
 *
 *   1. A manual write is blocked (409) when a protected Week 0 row already exists.
 *   2. A Week 0 capture is blocked (409) and leaves no partial rows when the date
 *      already has manual MTM data.
 *   3. In a concurrent race (Promise.all), the advisory lock serializes both writes:
 *      whichever commits first wins; the other receives 409 without leaving partial
 *      state behind.
 *
 * Isolation: a disposable season (year=9999) is created in before() and fully torn
 * down in after().  Cleanup removes only the season record and its children by ID —
 * no production records are ever touched.
 *
 * Requires DATABASE_URL and ADMIN_API_KEY; skipped otherwise.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { before, after, describe, test } from "node:test";
import { and, eq, isNotNull, inArray, isNull, notInArray } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const canRun = Boolean(DATABASE_URL && ADMIN_KEY);

// Deferred imports — must not execute when DATABASE_URL is absent (lib/db throws)
let db, eventsTable, mtmSnapshotsTable, mtmSnapshotTable, mtmEntryValuationTable, mtmValuationVersionTable, snapshotMetricsTable, seasonsTable, teamsTable, teamSeasonAuctionsTable, calcuttasTable, calcuttaEntriesTable, positionsTable, biddersTable, mtmCanonicalPeriodSelectionTable, calendarProjectionSnapshotsTable;
let app;
let WEEK_ZERO_SNAPSHOT_KEY;
let getMtmPipelineStatus;
let validateAndPromoteCurrentMtm;

if (canRun) {
  ({ db, eventsTable, mtmSnapshotsTable, mtmSnapshotTable, mtmEntryValuationTable, mtmValuationVersionTable, snapshotMetricsTable, seasonsTable, teamsTable, teamSeasonAuctionsTable, calcuttasTable, calcuttaEntriesTable, positionsTable, biddersTable, mtmCanonicalPeriodSelectionTable, calendarProjectionSnapshotsTable } =
    await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
  ({ WEEK_ZERO_SNAPSHOT_KEY } = await import("../lib/weekZeroValuation.ts"));
  ({ getMtmPipelineStatus } = await import("../lib/mtmPipeline.ts"));
  ({ validateAndPromoteCurrentMtm } = await import("../lib/currentMtm.ts"));
}

// ── Kalshi fetch mock ────────────────────────────────────────────────────────

const ALL_TEAM_TICKERS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB",  "HOU", "IND", "JAC", "KC",
  "LV",  "LAC", "LAR", "MIA", "MIN", "NE",  "NO",  "NYG",
  "NYJ", "PHI", "PIT", "SF",  "SEA", "TB",  "TEN", "WAS",
];

/**
 * Returns a fetch replacement that:
 *   - Forwards non-Kalshi URLs to `realFetch` unchanged (keeps the test's own
 *     HTTP calls to the local Express server working).
 *   - Returns deterministic fake market data for any Kalshi event URL.
 *   - Optionally waits `delayMs` before responding (used to control race timing).
 */
function makeKalshiMock(
  realFetch,
  { delayMs = 0, omitChampionshipTicker = null, staleTicker = null } = {},
) {
  return async function mockedFetch(url, options) {
    const urlStr = url.toString();
    if (!urlStr.includes("external-api.kalshi.com")) {
      return realFetch(url, options);
    }

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const match = urlStr.match(/\/events\/([^?]+)/);
    const eventTicker = match ? decodeURIComponent(match[1]) : "UNKNOWN";

    let markets;
    if (eventTicker.startsWith("KXNFLWINS-27")) {
      // Per-team win-threshold event: 17 markets with floor_strike 0.5–16.5
      markets = Array.from({ length: 17 }, (_, i) => ({
        ticker: `${eventTicker}-W${i + 1}`,
        floor_strike: i + 0.5,
        yes_bid_dollars: "0.49",
        yes_ask_dollars: "0.51",
        yes_bid_size_fp: "500",
        yes_ask_size_fp: "500",
        updated_time: "2026-08-19T12:00:00Z",
      }));
    } else {
      // Shared pool events (playoff, conf champion, championship): one market per team
      markets = ALL_TEAM_TICKERS.map((t) => ({
        ticker: `${eventTicker}-${t}`,
        yes_bid_dollars: "0.09",
        yes_ask_dollars: "0.11",
        yes_bid_size_fp: t === staleTicker ? "1" : "500",
        yes_ask_size_fp: t === staleTicker ? "1" : "500",
        updated_time: "2026-08-19T12:00:00Z",
      }));
      if (
        omitChampionshipTicker &&
        eventTicker.startsWith("KXSB-")
      ) {
        markets = markets.filter(
          (market) => !market.ticker.endsWith(`-${omitChampionshipTicker}`),
        );
      }
    }

    return new Response(JSON.stringify({ event: { markets } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ── HTTP server helpers ──────────────────────────────────────────────────────

function startServer(expressApp) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

// ── Main test suite ──────────────────────────────────────────────────────────

describe(
  "MTM write-path conflict protection (manual vs. Week 0 capture)",
  { skip: !canRun },
  () => {
    // Shared state created in before() and cleaned up in after()
    let testSeasonId;     // ID of the disposable year-9999 test season
    let testTeamIds;      // All 32 team IDs (shared teams table, not season-specific)
    let testCalcuttaId;
    let entryIdByTeam;
    let testBidderId;
    let server, baseUrl;
    let realFetch;

    // ── Fixture setup ──────────────────────────────────────────────────────

    before(async () => {
      // Create a disposable season so all test snapshots are fully isolated.
      // Year 9999 is explicitly mapped to the 2026-27 Kalshi contract set in
      // weekZeroValuation.ts, which the fetch mock intercepts at test time.
      const [season] = await db
        .insert(seasonsTable)
        .values({
          year: 9999,
          isActive: false,
          isComplete: false,
          label: "Integration-test fixture — safe to delete",
        })
        .onConflictDoUpdate({
          target: seasonsTable.year,
          set: { label: "Integration-test fixture — safe to delete" },
        })
        .returning();
      testSeasonId = season.id;

      // Load the shared 32-team roster and create auction records for the test season
      const teams = await db.select({ id: teamsTable.id }).from(teamsTable);
      assert.equal(
        teams.length,
        32,
        "all 32 NFL teams must exist in the database for Week 0 capture to work",
      );
      testTeamIds = teams.map((t) => t.id);

      await db
        .insert(teamSeasonAuctionsTable)
        .values(
          testTeamIds.map((teamId) => ({
            teamId,
            seasonId: testSeasonId,
            bidAmount: "1500.00",
          })),
        )
        .onConflictDoNothing();
      const [calcutta] = await db
        .insert(calcuttasTable)
        .values({
          seasonId: testSeasonId,
          year: 9999,
          name: "9999 NFL Calcutta",
          sport: "NFL",
          isCanonical: true,
        })
        .onConflictDoUpdate({
          target: calcuttasTable.name,
          set: { seasonId: testSeasonId, isCanonical: true },
        })
        .returning();
      testCalcuttaId = calcutta.id;
      // A prior interrupted run may have left pipeline/current-version rows
      // behind. Remove versions first because they restrict source snapshots.
      await db
        .update(mtmValuationVersionTable)
        .set({ status: "superseded" })
        .where(and(
          eq(mtmValuationVersionTable.poolId, testCalcuttaId),
          eq(mtmValuationVersionTable.status, "current"),
        ));
      // A prior interrupted run may have left pipeline-ledger rows behind.
      // This fixture owns the disposable 9999 pool, so reset that ledger
      // before creating assertions whose ordering depends on a clean history.
      const retainedSources = await db.select({
        sourceSnapshotId: mtmValuationVersionTable.sourceSnapshotId,
      }).from(mtmValuationVersionTable)
        .where(eq(mtmValuationVersionTable.poolId, testCalcuttaId));
      const retainedSourceIds = retainedSources.map((row) => row.sourceSnapshotId);
      await db.delete(mtmSnapshotTable).where(
        retainedSourceIds.length === 0
          ? eq(mtmSnapshotTable.poolId, testCalcuttaId)
          : and(
            eq(mtmSnapshotTable.poolId, testCalcuttaId),
            notInArray(mtmSnapshotTable.id, retainedSourceIds),
          ),
      );
      const entries = await db
        .insert(calcuttaEntriesTable)
        .values(testTeamIds.map((teamId) => ({ calcuttaId: calcutta.id, teamId })))
        .onConflictDoUpdate({
          target: [calcuttaEntriesTable.calcuttaId, calcuttaEntriesTable.teamId],
          set: { calcuttaId: calcutta.id },
        })
        .returning();
      entryIdByTeam = new Map(entries.map((entry) => [entry.teamId, entry.id]));
      const [bidder] = await db
        .insert(biddersTable)
        .values({ name: "MTM integration fixture bidder 9999" })
        .onConflictDoUpdate({
          target: biddersTable.name,
          set: { name: "MTM integration fixture bidder 9999" },
        })
        .returning();
      testBidderId = bidder.id;
      await db.delete(positionsTable).where(inArray(
        positionsTable.entryId,
        entries.map((entry) => entry.id),
      ));
      await db.insert(positionsTable).values(entries.map((entry) => ({
        entryId: entry.id,
        bidderId: bidder.id,
        ownershipShare: "1",
        source: "primary",
        costBasis: "1500",
      })));

      ({ server, baseUrl } = await startServer(app));
      realFetch = globalThis.fetch;
    });

    after(async () => {
      // Restore fetch in case a test failed before restoring it
      globalThis.fetch = realFetch;
      await stopServer(server);

      // Delete only records that belong to the test season, identified by ID
      // The pipeline ledger is separate from the legacy mtm_snapshots table.
      // Clean it by pool as well, otherwise a failed run can become the
      // "latest attempt" in the next run and contaminate status/history tests.
      if (testCalcuttaId != null) {
        const referenced = await db.select({ sourceSnapshotId: mtmValuationVersionTable.sourceSnapshotId })
          .from(mtmValuationVersionTable)
          .where(eq(mtmValuationVersionTable.poolId, testCalcuttaId));
        const referencedIds = referenced.map((row) => row.sourceSnapshotId);
        if (referencedIds.length === 0) {
          await db.delete(mtmSnapshotTable).where(eq(mtmSnapshotTable.poolId, testCalcuttaId));
        } else {
          await db.delete(mtmSnapshotTable).where(and(
            eq(mtmSnapshotTable.poolId, testCalcuttaId),
            notInArray(mtmSnapshotTable.id, referencedIds),
          ));
        }
      }
      await db
        .delete(mtmSnapshotsTable)
        .where(eq(mtmSnapshotsTable.seasonId, testSeasonId));
      await db
        .delete(teamSeasonAuctionsTable)
        .where(eq(teamSeasonAuctionsTable.seasonId, testSeasonId));
      // Current-version publication rows are append-only and retain their
      // source snapshots, so this disposable season cannot be cascaded away.
      // Its records are isolated to the 9999 fixture pool.
      await db.delete(biddersTable).where(eq(biddersTable.id, testBidderId));
    });

    // ── Shared request helpers ─────────────────────────────────────────────

    function postManualMtm({ teamId, snapshotDate, mtmValue = 42, calcuttaId }) {
      return fetch(`${baseUrl}/api/mtm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_KEY}`,
        },
        body: JSON.stringify({
          seasonYear: 9999,
          teamId,
          snapshotDate,
          mtmValue,
          ...(calcuttaId == null ? {} : { calcuttaId }),
        }),
      });
    }

    function postWeekZeroCapture({ snapshotDate, calcuttaId }) {
      return fetch(`${baseUrl}/api/mtm/week-zero/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_KEY}`,
        },
        body: JSON.stringify({
          seasonYear: 9999,
          snapshotDate,
          ...(calcuttaId == null ? {} : { calcuttaId }),
        }),
      });
    }

    async function insertWeekZeroRowDirectly(snapshotDate) {
      // Bypasses the HTTP route to set up a known Week 0 state with a tracked ID.
      const [row] = await db
        .insert(mtmSnapshotsTable)
        .values({
          entryId: entryIdByTeam.get(testTeamIds[0]),
          teamId: testTeamIds[0],
          seasonId: testSeasonId,
          weekNum: 0,
          snapshotDate,
          mtmValue: "100",
          snapshotKey: WEEK_ZERO_SNAPSHOT_KEY,
          source: "kalshi",
          capturedAt: new Date(),
          marketStatus: "live",
        })
        .returning({ id: mtmSnapshotsTable.id });
      return row.id;
    }

    async function snapshotsAtDate(snapshotDate) {
      return db
        .select({
          id: mtmSnapshotsTable.id,
          snapshotKey: mtmSnapshotsTable.snapshotKey,
          mtmValue: mtmSnapshotsTable.mtmValue,
          marketStatus: mtmSnapshotsTable.marketStatus,
        })
        .from(mtmSnapshotsTable)
        .where(
          and(
            eq(mtmSnapshotsTable.seasonId, testSeasonId),
            eq(mtmSnapshotsTable.snapshotDate, snapshotDate),
          ),
        );
    }

    async function deleteSnapshotsByIds(ids) {
      if (ids.length === 0) return;
      await db
        .delete(mtmSnapshotsTable)
        .where(inArray(mtmSnapshotsTable.id, ids));
    }

    async function setLegacyCalculatedMtm(teamId, value) {
      // A Results request creates the legacy Week 0 rows for this disposable
      // Calcutta. Change one of those rows so the test can prove that a
      // pipeline failure does not leak its calculated MTM value.
      const initial = await fetch(
        `${baseUrl}/api/results?season=9999&calcuttaId=${testCalcuttaId}`,
      );
      assert.equal(initial.status, 200);
      const entryId = entryIdByTeam.get(teamId);
      const [metric] = await db
        .select()
        .from(snapshotMetricsTable)
        .where(and(
          eq(snapshotMetricsTable.calcuttaId, testCalcuttaId),
          eq(snapshotMetricsTable.entryId, entryId),
          eq(snapshotMetricsTable.basis, "mtm"),
          eq(snapshotMetricsTable.metric, "win"),
        ))
        .limit(1);
      assert.ok(metric, "legacy MTM baseline metric must exist");
      await db
        .update(snapshotMetricsTable)
        .set({ value: String(value) })
        .where(eq(snapshotMetricsTable.id, metric.id));
      const legacyResponse = await fetch(
        `${baseUrl}/api/results?season=9999&calcuttaId=${testCalcuttaId}&basis=mtm`,
      );
      assert.equal(legacyResponse.status, 200);
      const legacyResults = await legacyResponse.json();
      const legacyTeam = legacyResults.find((row) => row.teamId === teamId);
      assert.ok(
        legacyTeam?.markToMarket > 0,
        "the seeded legacy calculated MTM must be nonzero before pipeline adoption",
      );
      return metric;
    }

    async function restoreLegacyCalculatedMtm(metric) {
      await db
        .update(snapshotMetricsTable)
        .set({
          value: metric.value,
          source: metric.source,
          sourceData: metric.sourceData,
        })
        .where(eq(snapshotMetricsTable.id, metric.id));
    }

    async function deletePipelineSnapshotsByIds(ids) {
      if (ids.length === 0) return;
      const referenced = await db.select({ sourceSnapshotId: mtmValuationVersionTable.sourceSnapshotId })
        .from(mtmValuationVersionTable)
        .where(inArray(mtmValuationVersionTable.sourceSnapshotId, ids));
      const referencedIds = new Set(referenced.map((row) => row.sourceSnapshotId));
      const deletableIds = ids.filter((id) => !referencedIds.has(id));
      if (deletableIds.length === 0) return;
      await db
        .delete(mtmSnapshotTable)
        .where(inArray(mtmSnapshotTable.id, deletableIds));
    }

    async function resetPipelineLedger() {
      const referenced = await db.select({ sourceSnapshotId: mtmValuationVersionTable.sourceSnapshotId })
        .from(mtmValuationVersionTable)
        .where(eq(mtmValuationVersionTable.poolId, testCalcuttaId));
      const referencedIds = referenced.map((row) => row.sourceSnapshotId);
      const condition = referencedIds.length === 0
        ? eq(mtmSnapshotTable.poolId, testCalcuttaId)
        : and(
          eq(mtmSnapshotTable.poolId, testCalcuttaId),
          notInArray(mtmSnapshotTable.id, referencedIds),
        );
      await db.delete(mtmSnapshotTable).where(condition);
    }

    async function resetCurrentVersionLedger() {
      await db
        .update(mtmValuationVersionTable)
        .set({ status: "superseded" })
        .where(and(
          eq(mtmValuationVersionTable.poolId, testCalcuttaId),
          eq(mtmValuationVersionTable.status, "current"),
        ));
    }

    async function seedCoherentOfficialVersion(value, {
      asOf = new Date(),
      fetchedAt = new Date(),
    } = {}) {
      const entries = [...entryIdByTeam.entries()];
      const pot = value * entries.length;
      const fetchedAtIso = fetchedAt.toISOString();
      await db.insert(eventsTable).values({
        seasonId: testSeasonId,
        sport: "NFL",
        competition: "NFL_REGULAR_SEASON",
        source: "espn",
        sourceEventId: "coherent-test-event",
        week: 2,
        eventDate: "9999-09-12",
        kickoffAt: new Date("9999-09-12T17:00:00.000Z"),
        awayTeamId: entries[0][0],
        homeTeamId: entries[1][0],
        status: "scheduled",
        sourceData: { sourceFetchedAt: fetchedAtIso },
      }).onConflictDoUpdate({
        target: [
          eventsTable.seasonId,
          eventsTable.sport,
          eventsTable.competition,
          eventsTable.source,
          eventsTable.sourceEventId,
        ],
        set: {
          status: "scheduled",
          sourceData: { sourceFetchedAt: fetchedAtIso },
        },
      });
      const [snapshot] = await db.insert(mtmSnapshotTable).values({
        poolId: testCalcuttaId,
        asOf,
        asOfHour: asOf,
        createdAt: asOf,
        trigger: "scheduled",
        status: "ok",
        methodVersion: "coherent-test",
        diagnostics: {
          publication_audit: {
            policy_version: "test-policy",
            status: "good",
            publication_decision: "approved",
            gate_results: {
              capture_completeness: "passed", freshness: "passed", metadata: "passed",
              final_ess: "passed", max_weight: "passed", precision: "not_applicable",
              support: "not_applicable", win_market_quality: "passed",
              playoff_market_calibration: "passed",
            },
            gate_reasons: [],
            final_effective_sample_size: 100,
            calibration: { status: "good" },
          },
        },
        stateJson: {
          pot,
          entries: entries.map(([teamId, entryId]) => ({
            team: `TEAM-${teamId}`,
            price: 1500,
            entry_id: String(entryId),
          })),
          remaining_schedule: [{ week: 2 }],
        },
        inputProvenance: {
          schema_version: "1.0",
          schedule: [{
            provider: "espn",
            source_id: "coherent-test-event",
            fetched_at: fetchedAtIso,
          }],
          realized_results: [],
          standings: entries.map(([teamId]) => ({
            provider: "derived_nfl_game_ledger",
            source_id: `coherent-test-${teamId}`,
            fetched_at: fetchedAtIso,
          })),
        },
      }).returning({ id: mtmSnapshotTable.id });
      await db.insert(mtmEntryValuationTable).values(entries.map(([, entryId]) => ({
        snapshotId: snapshot.id,
        entryId,
        expectedPayout: String(value),
        auctionPrice: "1500",
      })));
      const promotion = await validateAndPromoteCurrentMtm({
        poolId: testCalcuttaId,
        sourceSnapshotId: snapshot.id,
        markType: "official",
      });
      return { snapshotId: snapshot.id, versionId: promotion.versionId };
    }

    test(
      "official promotion rejects stale canonical event and result provenance",
      async () => {
        await resetCurrentVersionLedger();
        await resetPipelineLedger();
        const staleAt = new Date(Date.now() - 7 * 60 * 60 * 1_000);
        await assert.rejects(
          seedCoherentOfficialVersion(777, { asOf: staleAt, fetchedAt: staleAt }),
          /Canonical event ledger is stale.*Actual-results ledger is stale.*coherent-test-event.*is stale/,
        );
        const rejected = await db.select({ id: mtmSnapshotTable.id })
          .from(mtmSnapshotTable)
          .where(and(
            eq(mtmSnapshotTable.methodVersion, "coherent-test"),
            eq(mtmSnapshotTable.asOf, staleAt),
          ));
        assert.ok(rejected.length > 0);
        const rejectedIds = rejected.map((row) => row.id);
        assert.equal(
          (await db.select({ id: mtmCanonicalPeriodSelectionTable.id })
            .from(mtmCanonicalPeriodSelectionTable)
            .where(inArray(mtmCanonicalPeriodSelectionTable.snapshotId, rejectedIds))).length,
          0,
          "rejected official attempts must not select a canonical period",
        );
        assert.equal(
          (await db.select({ id: calendarProjectionSnapshotsTable.id })
            .from(calendarProjectionSnapshotsTable)
            .where(inArray(calendarProjectionSnapshotsTable.mtmSnapshotId, rejectedIds))).length,
          0,
          "rejected official attempts must not publish calendar projections",
        );
        await resetPipelineLedger();
      },
    );

    async function mtmMetricRowsForEntries(entryIds) {
      return db
        .select({
          id: snapshotMetricsTable.id,
          entryId: snapshotMetricsTable.entryId,
          metric: snapshotMetricsTable.metric,
          value: snapshotMetricsTable.value,
          source: snapshotMetricsTable.source,
          sourceData: snapshotMetricsTable.sourceData,
          snapshotAt: snapshotMetricsTable.snapshotAt,
        })
        .from(snapshotMetricsTable)
        .where(
          and(
            inArray(snapshotMetricsTable.entryId, entryIds),
            eq(snapshotMetricsTable.basis, "mtm"),
          ),
        );
    }

    // ── Baseline test A: manual blocked by existing Week 0 row ────────────

    test(
      "manual MTM POST returns 409 when a protected Week 0 row already holds that team/date",
      async () => {
        const DATE = "9999-09-01";
        const weekZeroId = await insertWeekZeroRowDirectly(DATE);

        try {
          const res = await postManualMtm({ teamId: testTeamIds[0], snapshotDate: DATE });

          assert.equal(res.status, 409, "manual write must be rejected with 409 Conflict");
          const body = await res.json();
          assert.ok(
            typeof body.error === "string" && body.error.length > 0,
            "conflict response must include an error message",
          );

          // Protected row must still be intact — value and key unchanged
          const rows = await snapshotsAtDate(DATE);
          assert.equal(rows.length, 1, "exactly one snapshot must remain");
          assert.equal(
            rows[0].snapshotKey,
            WEEK_ZERO_SNAPSHOT_KEY,
            "protected snapshot key must be intact",
          );
          assert.equal(rows[0].mtmValue, "100.0000", "Week 0 value must not be overwritten");
        } finally {
          await deleteSnapshotsByIds([weekZeroId]);
        }
      },
    );

    test(
      "an incomplete market capture rejects before replacing prior Week 0 snapshots or metrics",
      async () => {
        const DATE = "9999-09-09";
        globalThis.fetch = makeKalshiMock(realFetch);
        const initial = await postWeekZeroCapture({ snapshotDate: DATE });
        assert.equal(initial.status, 200, "complete setup capture must succeed");
        const beforeSnapshots = await snapshotsAtDate(DATE);
        const beforeMetrics = await mtmMetricRowsForEntries(
          [...entryIdByTeam.values()],
        );
        assert.equal(beforeSnapshots.length, 32);
        assert.equal(beforeMetrics.length, 32 * 8);

        globalThis.fetch = makeKalshiMock(realFetch, {
          omitChampionshipTicker: "ARI",
        });
        try {
          const response = await postWeekZeroCapture({ snapshotDate: DATE });
          assert.ok(response.status >= 400, "incomplete capture must be rejected");
          const afterSnapshots = await snapshotsAtDate(DATE);
          const afterMetrics = await mtmMetricRowsForEntries(
            [...entryIdByTeam.values()],
          );
          assert.deepEqual(
            afterSnapshots,
            beforeSnapshots,
            "incomplete input must leave every prior Week 0 snapshot untouched",
          );
          assert.deepEqual(
            afterMetrics,
            beforeMetrics,
            "incomplete input must leave every prior derived metric untouched",
          );
        } finally {
          globalThis.fetch = realFetch;
          const leaked = await snapshotsAtDate(DATE);
          await deleteSnapshotsByIds(leaked.map((row) => row.id));
        }
      },
    );

    test(
      "a complete stale capture persists and exposes its warning metadata",
      async () => {
        const DATE = "9999-09-11";
        globalThis.fetch = makeKalshiMock(realFetch, { staleTicker: "ARI" });
        try {
          const capture = await postWeekZeroCapture({ snapshotDate: DATE });
          assert.equal(capture.status, 200, "stale but usable capture must publish");
          const captureBody = await capture.json();
          assert.ok(captureBody.marketStatusCounts.stale > 0);

          const response = await fetch(
            `${baseUrl}/api/mtm?season=9999&calcuttaId=${testCalcuttaId}`,
          );
          assert.equal(response.status, 200);
          const body = await response.json();
          const weekZero = body.weeks.find((week) => week.snapshotDate === DATE);
          assert.ok(weekZero, "stored stale capture must be returned");
          const staleTeams = weekZero.teamValues.filter(
            (team) => team.marketStatus === "stale",
          );
          assert.ok(staleTeams.length > 0);
          assert.ok(
            staleTeams.every((team) => team.marketStatusReasons.length > 0),
            "every stale mark must include warning reasons",
          );

          const resultResponses = await Promise.all([
            fetch(`${baseUrl}/api/results?season=9999&calcuttaId=${testCalcuttaId}`),
            fetch(`${baseUrl}/api/results/by-owner?season=9999&calcuttaId=${testCalcuttaId}`),
            fetch(
              `${baseUrl}/api/v2/owner/portfolio?season=9999&calcuttaId=${testCalcuttaId}&owner=${encodeURIComponent("MTM integration fixture bidder 9999")}`,
            ),
            fetch(
              `${baseUrl}/api/v2/leaderboard/consortia?season=9999&calcuttaId=${testCalcuttaId}`,
            ),
          ]);
          assert.ok(resultResponses.every((item) => item.status === 200));
          const [teamResults, ownerResults, portfolio, leaderboard] =
            await Promise.all(resultResponses.map((item) => item.json()));

          assert.ok(teamResults.some(
            (team) =>
              team.marketStatus === "stale" &&
              team.marketStatusReasons.length > 0,
          ));
          assert.ok(ownerResults.some(
            (owner) =>
              owner.marketStatus === "stale" &&
              owner.marketStatusReasons.length > 0 &&
              owner.teams.some((team) => team.marketStatus === "stale"),
          ));
          assert.equal(portfolio.market_status, "stale");
          assert.ok(portfolio.market_status_reasons.length > 0);
          assert.ok(portfolio.teams.some(
            (team) =>
              team.market_status === "stale" &&
              team.market_status_reasons.length > 0,
          ));
          assert.equal(leaderboard.market_status, "stale");
          assert.ok(leaderboard.market_status_reasons.length > 0);
          assert.ok(leaderboard.rows.some(
            (row) =>
              row.market_status === "stale" &&
              row.market_status_reasons.length > 0,
          ));
        } finally {
          globalThis.fetch = realFetch;
          const leaked = await snapshotsAtDate(DATE);
          await deleteSnapshotsByIds(leaked.map((row) => row.id));
        }
      },
    );

    // ── Baseline test B: Week 0 capture blocked by existing manual entry ──

    test(
      "Week 0 capture returns 409 and commits no partial rows when the date already has manual MTM data",
      async () => {
        const DATE = "9999-09-02";

        // Insert a manual entry via the real API route (tests the manual-write path)
        const setupRes = await postManualMtm({ teamId: testTeamIds[0], snapshotDate: DATE });
        assert.equal(setupRes.status, 200, "manual MTM setup must succeed");
        const setupBody = await setupRes.json();
        const manualId = setupBody.id;
        assert.ok(typeof manualId === "number", "setup response must include the inserted row ID");

        globalThis.fetch = makeKalshiMock(realFetch);
        try {
          const res = await postWeekZeroCapture({ snapshotDate: DATE });
          assert.equal(
            res.status,
            409,
            "Week 0 capture must be blocked with 409 Conflict when the date is occupied",
          );
          const body = await res.json();
          assert.ok(
            typeof body.error === "string" && body.error.length > 0,
            "conflict response must include an error message",
          );

          // No Week 0 rows must have been committed — the transaction must have rolled back
          const rows = await snapshotsAtDate(DATE);
          const weekZeroRows = rows.filter((r) => r.snapshotKey === WEEK_ZERO_SNAPSHOT_KEY);
          assert.equal(
            weekZeroRows.length,
            0,
            "no partial Week 0 rows must remain after a failed capture",
          );
        } finally {
          globalThis.fetch = realFetch;
          await deleteSnapshotsByIds([manualId]);
        }
      },
    );

    test(
      "Week 0 capture and recapture succeed with the partial snapshot-key uniqueness index",
      async () => {
        const DATE = "9999-09-05";
        globalThis.fetch = makeKalshiMock(realFetch);
        try {
          const firstCapture = await postWeekZeroCapture({ snapshotDate: DATE });
          assert.equal(firstCapture.status, 200, "initial Week 0 capture must succeed");
          const firstMetrics = await mtmMetricRowsForEntries(
            [...entryIdByTeam.values()],
          );
          assert.equal(
            firstMetrics.length,
            32 * 8,
            "one MTM row per team and calculation metric must be stored",
          );
          assert.ok(firstMetrics.every((row) =>
            row.source === "kalshi" &&
            row.sourceData.rawSnapshotKey === WEEK_ZERO_SNAPSHOT_KEY &&
            row.sourceData.rawSnapshotDate === DATE
          ));

          const recapture = await postWeekZeroCapture({ snapshotDate: DATE });
          assert.equal(recapture.status, 200, "Week 0 recapture must use the partial unique index");

          const rows = await snapshotsAtDate(DATE);
          assert.equal(rows.length, 32, "one protected snapshot must exist for every team");
          assert.ok(
            rows.every((row) => row.snapshotKey === WEEK_ZERO_SNAPSHOT_KEY),
            "all rows must retain the protected Week 0 key",
          );
          const recapturedMetrics = await mtmMetricRowsForEntries(
            [...entryIdByTeam.values()],
          );
          assert.equal(
            recapturedMetrics.length,
            32 * 8,
            "recapture must replace rather than duplicate derived metrics",
          );
          await deleteSnapshotsByIds(rows.map((row) => row.id));
        } finally {
          globalThis.fetch = realFetch;
          const leaked = await snapshotsAtDate(DATE);
          await deleteSnapshotsByIds(leaked.map((row) => row.id));
        }
      },
    );

    test(
      "two Calcuttas in one season keep manual values and Week 0 captures entry-scoped",
      async () => {
        const MANUAL_DATE = "9999-09-06";
        const WEEK_ZERO_DATE = "9999-09-07";
        const [secondCalcutta] = await db.insert(calcuttasTable).values({
          seasonId: testSeasonId,
          year: 9999,
          name: "9999 alternate NFL Calcutta",
          sport: "NFL",
          isCanonical: false,
        }).returning();
        const secondEntries = await db.insert(calcuttaEntriesTable)
          .values(testTeamIds.map((teamId) => ({
            calcuttaId: secondCalcutta.id,
            teamId,
          })))
          .returning();
        await db.insert(positionsTable).values(secondEntries.map((entry) => ({
          entryId: entry.id,
          bidderId: testBidderId,
          ownershipShare: "1",
          source: "primary",
          costBasis: "1000",
        })));

        globalThis.fetch = makeKalshiMock(realFetch);
        try {
          const [canonicalManual, alternateManual] = await Promise.all([
            postManualMtm({
              calcuttaId: testCalcuttaId,
              teamId: testTeamIds[0],
              snapshotDate: MANUAL_DATE,
              mtmValue: 111,
            }),
            postManualMtm({
              calcuttaId: secondCalcutta.id,
              teamId: testTeamIds[0],
              snapshotDate: MANUAL_DATE,
              mtmValue: 222,
            }),
          ]);
          assert.equal(canonicalManual.status, 200);
          assert.equal(alternateManual.status, 200);
          const manualRows = await snapshotsAtDate(MANUAL_DATE);
          assert.equal(manualRows.length, 2);
          assert.deepEqual(
            manualRows.map((row) => Number(row.mtmValue)).sort((a, b) => a - b),
            [111, 222],
          );

          const firstCapture = await postWeekZeroCapture({
            calcuttaId: testCalcuttaId,
            snapshotDate: WEEK_ZERO_DATE,
          });
          assert.equal(firstCapture.status, 200);
          const canonicalBefore = await snapshotsAtDate(WEEK_ZERO_DATE);
          assert.equal(canonicalBefore.length, 32);
          const canonicalIds = new Set(canonicalBefore.map((row) => row.id));
          const canonicalMetricsBefore = await mtmMetricRowsForEntries(
            [...entryIdByTeam.values()],
          );
          assert.equal(canonicalMetricsBefore.length, 32 * 8);
          const canonicalMetricIds = canonicalMetricsBefore
            .map((row) => row.id)
            .sort((a, b) => a - b);

          const secondCapture = await postWeekZeroCapture({
            calcuttaId: secondCalcutta.id,
            snapshotDate: WEEK_ZERO_DATE,
          });
          assert.equal(secondCapture.status, 200);
          const combined = await snapshotsAtDate(WEEK_ZERO_DATE);
          assert.equal(combined.length, 64);
          const combinedIds = new Set(combined.map((row) => row.id));
          assert.ok(
            canonicalBefore.every(
              (row) => canonicalIds.has(row.id) && combinedIds.has(row.id),
            ),
            "the alternate capture must not replace canonical snapshot identities",
          );
          const canonicalMetricsAfter = await mtmMetricRowsForEntries(
            [...entryIdByTeam.values()],
          );
          assert.deepEqual(
            canonicalMetricsAfter.map((row) => row.id).sort((a, b) => a - b),
            canonicalMetricIds,
            "the alternate capture must not replace canonical metric rows",
          );
          const alternateMetrics = await mtmMetricRowsForEntries(
            secondEntries.map((entry) => entry.id),
          );
          assert.equal(alternateMetrics.length, 32 * 8);
        } finally {
          globalThis.fetch = realFetch;
          await db.delete(mtmSnapshotsTable).where(and(
            eq(mtmSnapshotsTable.seasonId, testSeasonId),
            inArray(mtmSnapshotsTable.snapshotDate, [MANUAL_DATE, WEEK_ZERO_DATE]),
          ));
          await db.delete(calcuttasTable).where(eq(calcuttasTable.id, secondCalcutta.id));
        }
      },
    );

    test(
      "Results retain the promoted coherent mark when a newer pipeline attempt fails",
      async () => {
        await resetCurrentVersionLedger();
        await resetPipelineLedger();
        const teamId = testTeamIds[0];
         const coherent = await seedCoherentOfficialVersion(777);
        let pipelineSnapshotIds = [];
        try {
          const priorAsOf = new Date(Date.now() - 60_000);
          const latestAsOf = new Date(Date.now());
          const [prior] = await db
            .insert(mtmSnapshotTable)
            .values({
              poolId: testCalcuttaId,
              asOf: priorAsOf,
              asOfHour: priorAsOf,
              createdAt: priorAsOf,
              trigger: "scheduled",
              status: "ok",
              methodVersion: "test",
            })
            .returning({ id: mtmSnapshotTable.id });
          await db.insert(mtmEntryValuationTable).values(
            [...entryIdByTeam.values()].map((entryId) => ({
              snapshotId: prior.id,
              entryId,
              expectedPayout: "777",
            })),
          );
          const completeResponse = await fetch(
            `${baseUrl}/api/results?season=9999&calcuttaId=${testCalcuttaId}&basis=mtm`,
          );
          assert.equal(completeResponse.status, 200);
          const completeResults = await completeResponse.json();
          const completeTeam = completeResults.find((row) => row.teamId === teamId);
          assert.equal(
            completeTeam?.markToMarket,
            777,
            "the promoted coherent mark must remain authoritative",
          );
           assert.equal(completeTeam?.currentMtmVersion.versionId, coherent.versionId);
           assert.equal(completeTeam?.currentMtmVersion.sourceSnapshotId, coherent.snapshotId);
           assert.equal(completeTeam?.currentMtmVersion.markType, "official");
           assert.equal(completeTeam?.marketStatus, "live");

          const [latest] = await db
            .insert(mtmSnapshotTable)
            .values({
              poolId: testCalcuttaId,
              asOf: latestAsOf,
              asOfHour: latestAsOf,
              createdAt: latestAsOf,
              trigger: "scheduled",
              status: "failed",
              methodVersion: "test",
              error: "test capture failed",
            })
            .returning({ id: mtmSnapshotTable.id });
          pipelineSnapshotIds = [prior.id, latest.id];

          const [teamResponse, ownerResponse] = await Promise.all([
            fetch(`${baseUrl}/api/results?season=9999&calcuttaId=${testCalcuttaId}&basis=mtm`),
            fetch(`${baseUrl}/api/results/by-owner?season=9999&calcuttaId=${testCalcuttaId}&basis=mtm`),
          ]);
          assert.equal(teamResponse.status, 200);
          assert.equal(ownerResponse.status, 200);
          const [teamResults, ownerResults] = await Promise.all([
            teamResponse.json(),
            ownerResponse.json(),
          ]);
          const team = teamResults.find((row) => row.teamId === teamId);
          const owner = ownerResults.find(
            (row) => row.bidderName === "MTM integration fixture bidder 9999",
          );
          const ownerTeam = owner?.teams.find((row) => row.teamId === teamId);
          assert.ok(team);
          assert.ok(owner);
          assert.ok(ownerTeam);
           assert.equal(team.markToMarket, 777, "failed capture must not override the promoted coherent mark");
           assert.equal(team.netMtm, 777 - team.cost);
           assert.equal(team.currentMtmVersion.versionId, coherent.versionId);
           assert.equal(team.currentMtmVersion.sourceSnapshotId, coherent.snapshotId);
           assert.equal(team.marketStatus, "live");
           assert.deepEqual(team.marketStatusReasons, []);
          assert.equal(ownerTeam.markToMarket, 777);
           assert.equal(ownerTeam.currentMtmVersion.sourceSnapshotId, coherent.snapshotId);
          assert.equal(owner.totalMtm, 777 * entryIdByTeam.size);
           assert.equal(owner.currentMtmVersion.versionId, coherent.versionId);
           assert.equal(owner.currentMtmVersion.sourceSnapshotId, coherent.snapshotId);
           assert.equal(owner.marketStatus, "live");
           assert.deepEqual(owner.marketStatusReasons, []);
        } finally {
           await resetCurrentVersionLedger();
          await deletePipelineSnapshotsByIds(pipelineSnapshotIds);
          await resetPipelineLedger();
        }
      },
    );

    test(
      "Results ignore an incomplete raw snapshot and retain the promoted coherent mark",
      async () => {
        await resetCurrentVersionLedger();
        const teamId = testTeamIds[0];
         const coherent = await seedCoherentOfficialVersion(777);
        let pipelineSnapshotId;
        try {
          const asOf = new Date("2026-08-30T12:00:00.000Z");
          const [snapshot] = await db
            .insert(mtmSnapshotTable)
            .values({
              poolId: testCalcuttaId,
              asOf,
              asOfHour: asOf,
              createdAt: asOf,
              trigger: "manual",
              status: "ok",
              methodVersion: "test",
            })
            .returning({ id: mtmSnapshotTable.id });
          pipelineSnapshotId = snapshot.id;
          await db.insert(mtmEntryValuationTable).values(
            [...entryIdByTeam.values()].slice(1).map((entryId) => ({
              snapshotId: snapshot.id,
              entryId,
              expectedPayout: "888",
            })),
          );

          const [teamResponse, ownerResponse] = await Promise.all([
            fetch(`${baseUrl}/api/results?season=9999&calcuttaId=${testCalcuttaId}&basis=mtm`),
            fetch(`${baseUrl}/api/results/by-owner?season=9999&calcuttaId=${testCalcuttaId}&basis=mtm`),
          ]);
          assert.equal(teamResponse.status, 200);
          assert.equal(ownerResponse.status, 200);
          const [teamResults, ownerResults] = await Promise.all([
            teamResponse.json(),
            ownerResponse.json(),
          ]);
          const team = teamResults.find((row) => row.teamId === teamId);
          const owner = ownerResults.find(
            (row) => row.bidderName === "MTM integration fixture bidder 9999",
          );
          const ownerTeam = owner?.teams.find((row) => row.teamId === teamId);
          assert.ok(team);
          assert.ok(owner);
          assert.ok(ownerTeam);
            assert.equal(team.markToMarket, 777, "partial raw capture must not override coherent MTM");
            assert.equal(team.currentMtmVersion.versionId, coherent.versionId);
            assert.equal(team.currentMtmVersion.sourceSnapshotId, coherent.snapshotId);
           assert.equal(team.marketStatus, "live");
           assert.deepEqual(team.marketStatusReasons, []);
            assert.equal(ownerTeam.markToMarket, 777);
           assert.equal(ownerTeam.currentMtmVersion.sourceSnapshotId, coherent.snapshotId);
           assert.equal(owner.totalMtm, 777 * entryIdByTeam.size);
           assert.equal(owner.currentMtmVersion.versionId, coherent.versionId);
           assert.equal(owner.currentMtmVersion.sourceSnapshotId, coherent.snapshotId);
           assert.equal(owner.marketStatus, "live");
           assert.deepEqual(owner.marketStatusReasons, []);
        } finally {
           await resetCurrentVersionLedger();
          await deletePipelineSnapshotsByIds(
            pipelineSnapshotId == null ? [] : [pipelineSnapshotId],
          );
           await resetPipelineLedger();
        }
      },
    );

    test(
      "pipeline status excludes successful raw attempts that were never coherently promoted",
      async () => {
        await resetPipelineLedger();
        const entryIds = [...entryIdByTeam.values()];
         const weekZeroAt = new Date("2099-08-25T12:00:00.000Z");
         const weekZeroRetryAt = new Date("2099-08-26T12:00:00.000Z");
         const weekOneAt = new Date("2099-09-01T12:00:00.000Z");
         const failedAt = new Date("2099-09-01T13:00:00.000Z");
        let pipelineSnapshotIds = [];
         const sourceEntries = entryIds.map((entryId, index) => ({
           team: `TEAM-${testTeamIds[index]}`,
           price: 1500,
           entry_id: String(entryId),
         }));

        try {
          const inserted = await db
            .insert(mtmSnapshotTable)
            .values([
              {
                poolId: testCalcuttaId,
                asOf: weekOneAt,
                asOfHour: weekOneAt,
                createdAt: weekOneAt,
                trigger: "scheduled",
                status: "ok",
                methodVersion: "test",
                stateJson: {
                   entries: sourceEntries,
                  remaining_schedule: [{ week: 2 }],
                },
              },
              {
                poolId: testCalcuttaId,
                asOf: weekZeroRetryAt,
                asOfHour: weekZeroRetryAt,
                createdAt: weekZeroRetryAt,
                trigger: "scheduled",
                status: "ok",
                methodVersion: "test",
                stateJson: {
                   entries: sourceEntries,
                  remaining_schedule: [{ week: 1 }],
                },
              },
              {
                poolId: testCalcuttaId,
                asOf: weekZeroAt,
                asOfHour: weekZeroAt,
                createdAt: weekZeroAt,
                trigger: "scheduled",
                status: "ok",
                methodVersion: "test",
                stateJson: {
                   entries: sourceEntries,
                  remaining_schedule: [{ week: 1 }],
                },
              },
              {
                poolId: testCalcuttaId,
                asOf: failedAt,
                asOfHour: failedAt,
                createdAt: failedAt,
                trigger: "scheduled",
                status: "failed",
                methodVersion: "test",
                error: "test weekly retry failed",
              },
            ])
            .returning({ id: mtmSnapshotTable.id, asOf: mtmSnapshotTable.asOf });
          pipelineSnapshotIds = inserted.map((snapshot) => snapshot.id);
          const weekOne = inserted.find((snapshot) => snapshot.asOf.getTime() === weekOneAt.getTime());
          const weekZero = inserted.find((snapshot) => snapshot.asOf.getTime() === weekZeroAt.getTime());
          const weekZeroRetry = inserted.find(
            (snapshot) => snapshot.asOf.getTime() === weekZeroRetryAt.getTime(),
          );
          const failed = inserted.find((snapshot) => snapshot.asOf.getTime() === failedAt.getTime());
          assert.ok(weekZero && weekZeroRetry && weekOne && failed);

          await db.insert(mtmEntryValuationTable).values([
            ...entryIds.map((entryId, index) => ({
              snapshotId: weekZero.id,
              entryId,
              expectedPoints: String(10 + index),
              expectedPayout: String(900 + index * 25),
              auctionPrice: "1500",
              mtmMultiple: "1",
            })),
            ...entryIds.map((entryId, index) => ({
              snapshotId: weekZeroRetry.id,
              entryId,
              expectedPoints: String(11 + index),
              expectedPayout: String(950 + index * 25),
              auctionPrice: "1500",
              mtmMultiple: "1",
            })),
            ...entryIds.map((entryId, index) => ({
              snapshotId: weekOne.id,
              entryId,
              expectedPoints: String(42 - index),
              expectedPayout: String(1800 - index * 20),
              auctionPrice: "1500",
              mtmMultiple: "1",
            })),
          ]);

          const status = await getMtmPipelineStatus(9999, testCalcuttaId);
          assert.ok(status);
          assert.equal(status.id, failed.id, "the failed retry remains the latest attempt");
          assert.equal(status.currentSnapshotId, null, "an unpromoted success must not become current");
          assert.equal(status.status, "failed");
          assert.ok(status.staleReasons.includes("test weekly retry failed"));
          assert.equal(status.valuations.length, 0);
        } finally {
          await deletePipelineSnapshotsByIds(pipelineSnapshotIds);
          await resetPipelineLedger();
        }
      },
    );

    // ── Concurrent race test ───────────────────────────────────────────────

    test(
      "concurrent manual MTM and Week 0 capture writes serialize via advisory lock: one wins, the other gets 409, DB state is clean",
      async () => {
        const DATE = "9999-09-03";

        // The manual MTM route has no external I/O, so it commits very quickly.
        // A per-request Kalshi delay ensures the Week 0 route's Kalshi fetches
        // (4 parallel + 32 sequential batches) finish after the manual write has
        // already committed, making the manual write win the advisory lock race
        // deterministically.
        const KALSHI_DELAY_MS = 30;

        globalThis.fetch = makeKalshiMock(realFetch, { delayMs: KALSHI_DELAY_MS });
        try {
          // Fire both writes concurrently. A 5 ms head start for the manual
          // request (plus the Kalshi delay overhead) makes the advisory lock
          // race outcome deterministic: manual commits first, Week 0 finds the
          // collision and returns 409 without persisting any rows.
          const [manualRes, weekZeroRes] = await Promise.all([
            postManualMtm({ teamId: testTeamIds[0], snapshotDate: DATE }),
            new Promise((r) => setTimeout(r, 5)).then(() =>
              postWeekZeroCapture({ snapshotDate: DATE }),
            ),
          ]);

          // Exactly one must succeed and one must fail with 409
          const statuses = [manualRes.status, weekZeroRes.status].sort();
          assert.deepEqual(
            statuses,
            [200, 409],
            `one request must succeed (200) and one must fail (409); got ${JSON.stringify(statuses)}`,
          );

          // Parse both bodies to inspect the conflict message
          const [manualBody, weekZeroBody] = await Promise.all([
            manualRes.json(),
            weekZeroRes.json(),
          ]);

          const loserBody = manualRes.status === 409 ? manualBody : weekZeroBody;
          assert.ok(
            typeof loserBody.error === "string" && loserBody.error.length > 0,
            "the losing request must include an error message",
          );

          // DB must be consistent — verify no mixed state exists at the test date
          const rows = await snapshotsAtDate(DATE);
          const weekZeroRows = rows.filter((r) => r.snapshotKey === WEEK_ZERO_SNAPSHOT_KEY);
          const manualRows = rows.filter((r) => r.snapshotKey == null);

          if (manualRes.status === 200) {
            // Manual won: exactly one manual row, zero Week 0 rows
            assert.equal(
              weekZeroRows.length,
              0,
              "when manual wins, no Week 0 rows must be present at the date",
            );
            assert.equal(
              manualRows.length,
              1,
              "when manual wins, exactly one manual row must be present",
            );
          } else {
            // Week 0 won: all 32 rows present, zero manual rows
            assert.equal(
              weekZeroRows.length,
              32,
              "when Week 0 wins, all 32 capture rows must be present",
            );
            assert.equal(
              manualRows.length,
              0,
              "when Week 0 wins, no manual (null-key) rows must be present",
            );
          }

          // Cleanup: delete only the rows created in this test, by their IDs
          const createdIds = rows.map((r) => r.id);
          await deleteSnapshotsByIds(createdIds);
        } finally {
          globalThis.fetch = realFetch;
          // Safety net: ensure no rows leaked (idempotent, deletes zero rows if
          // the in-test cleanup above succeeded)
          const leaked = await snapshotsAtDate(DATE);
          await deleteSnapshotsByIds(leaked.map((r) => r.id));
        }
      },
    );
  },
);
