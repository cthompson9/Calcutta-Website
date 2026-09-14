import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

const canRun = Boolean(process.env.DATABASE_URL && process.env.ADMIN_API_KEY);
const ADMIN_KEY = process.env.ADMIN_API_KEY;

let app;
let db;
let seasonsTable;
let calcuttasTable;
let mtmSnapshotTable;
let mtmMarketQuoteTable;
let mtmValuationVersionTable;
let runDatabaseMigrations;

if (canRun) {
  ({
    db,
    seasonsTable,
    calcuttasTable,
    mtmSnapshotTable,
    mtmMarketQuoteTable,
    mtmValuationVersionTable,
    runDatabaseMigrations,
  } = await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
}

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
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("MTM pipeline evidence", { skip: !canRun }, () => {
  let seasonId;
  let poolId;
  let otherPoolId;
  let failedAttemptId;
  let successfulAttemptId;
  let otherPoolAttemptId;
  let server;
  let baseUrl;

  before(async () => {
    await runDatabaseMigrations();
    await db.delete(seasonsTable).where(eq(seasonsTable.year, 9877));
    const [season] = await db
      .insert(seasonsTable)
      .values({
        year: 9877,
        label: "MTM evidence route test",
        isActive: false,
        isComplete: false,
      })
      .onConflictDoUpdate({
        target: seasonsTable.year,
        set: { label: "MTM evidence route test" },
      })
      .returning();
    seasonId = season.id;

    const pools = await db
      .insert(calcuttasTable)
      .values([
        {
          seasonId,
          year: 9877,
          name: "MTM evidence route test pool 9877",
          sport: "NFL",
          isCanonical: true,
        },
        {
          seasonId,
          year: 9877,
          name: "MTM evidence route other pool 9877",
          sport: "NFL",
          isCanonical: false,
        },
      ])
      .onConflictDoNothing()
      .returning();
    poolId = pools.find((pool) => pool.name === "MTM evidence route test pool 9877")?.id;
    otherPoolId = pools.find((pool) => pool.name === "MTM evidence route other pool 9877")?.id;
    assert.ok(poolId);
    assert.ok(otherPoolId);

    const asOfHour = new Date("2026-09-20T14:00:00.000Z");
    const attempts = await db
      .insert(mtmSnapshotTable)
      .values([
        {
          poolId,
          asOf: new Date("2026-09-20T14:05:00.000Z"),
          asOfHour,
          trigger: "scheduled",
          status: "failed",
          methodVersion: "test",
          error: "Kalshi quote collection was incomplete: BUF stage of elimination: timeout",
          diagnostics: { quoteErrors: ["BUF stage of elimination: timeout"] },
          createdAt: new Date("2026-09-20T14:05:00.000Z"),
        },
        {
          poolId,
          asOf: new Date("2026-09-20T14:10:00.000Z"),
          asOfHour,
          trigger: "manual",
          status: "ok",
          methodVersion: "test",
          createdAt: new Date("2026-09-20T14:10:00.000Z"),
        },
        {
          poolId: otherPoolId,
          asOf: new Date("2026-09-20T14:15:00.000Z"),
          asOfHour,
          trigger: "manual",
          status: "ok",
          methodVersion: "test",
          createdAt: new Date("2026-09-20T14:15:00.000Z"),
        },
      ])
      .returning();
    failedAttemptId = attempts[0].id;
    successfulAttemptId = attempts[1].id;
    otherPoolAttemptId = attempts[2].id;

    await db.insert(mtmMarketQuoteTable).values([
      {
        snapshotId: failedAttemptId,
        series: "KXNFLWINS",
        marketTicker: "KXNFLWINS-27BUF-W10",
        team: null,
        strike: "10.50",
        yesBid: "0.4200",
        yesAsk: "0.4600",
        volume: 123,
        fetchedAt: new Date("2026-09-20T14:04:00.000Z"),
      },
      {
        snapshotId: successfulAttemptId,
        series: "KXNFLSTAGEOFELIM",
        marketTicker: "KXNFLSTAGEOFELIM-27BUF-DIV",
        team: "BUF",
        yesBid: "0.2500",
        yesAsk: "0.3000",
        volume: 55,
        fetchedAt: new Date("2026-09-20T14:09:00.000Z"),
      },
    ]);
    await db.insert(mtmValuationVersionTable).values({
      poolId,
      sourceSnapshotId: failedAttemptId,
      actualsStateHash: "mtm-evidence-delete-test",
      actualsAsOf: new Date("2026-09-20T14:05:00.000Z"),
      mtmAsOf: new Date("2026-09-20T14:05:00.000Z"),
      markType: "official",
      status: "candidate",
    });
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await stopServer(server);
    if (seasonId) {
      await db.delete(seasonsTable).where(eq(seasonsTable.id, seasonId));
    }
  });

  test("requires admin authorization", async () => {
    const response = await fetch(`${baseUrl}/api/mtm/pipeline/evidence?season=9877`);
    assert.equal(response.status, 401);
  });

  test("selects immutable same-hour failed and successful attempts", async () => {
    const response = await fetch(
      `${baseUrl}/api/mtm/pipeline/evidence?season=9877&attemptId=${failedAttemptId}`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.attempts.map((attempt) => attempt.id), [
      successfulAttemptId,
      failedAttemptId,
    ]);
    assert.equal(payload.selectedAttempt.id, failedAttemptId);
    assert.equal(payload.selectedAttempt.status, "failed");
    assert.equal(payload.selectedAttempt.deletable, true);
    assert.equal(payload.selectedAttempt.deleteBlockedReason, null);
    assert.equal(payload.attempts.find((attempt) => attempt.id === successfulAttemptId).deletable, true);
    assert.deepEqual(payload.selectedAttempt.failedSources, [
      "BUF stage of elimination: timeout",
    ]);
    assert.deepEqual(payload.selectedAttempt.receivedMarkets, [{
      series: "KXNFLWINS",
      quoteCount: 1,
      teams: ["BUF"],
    }]);
    assert.deepEqual(payload.selectedAttempt.quotes[0], {
      source: "kalshi",
      series: "KXNFLWINS",
      ticker: "KXNFLWINS-27BUF-W10",
      team: "BUF",
      bid: 0.42,
      ask: 0.46,
      strike: 10.5,
      volume: 123,
      fetchedAt: "2026-09-20T14:04:00.000Z",
    });
  });

  test("rejects an attempt that belongs to another pool", async () => {
    const response = await fetch(
      `${baseUrl}/api/mtm/pipeline/evidence?season=9877&calcuttaId=${poolId}&attemptId=${otherPoolAttemptId}`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    );
    assert.equal(response.status, 404);
  });

  test("requires admin authorization to delete an attempt", async () => {
    const response = await fetch(
      `${baseUrl}/api/mtm/pipeline/attempts/${failedAttemptId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season: 9877, calcuttaId: poolId, confirmed: true }),
      },
    );
    assert.equal(response.status, 401);
  });

  test("rejects deletion through the wrong Calcutta", async () => {
    const response = await fetch(
      `${baseUrl}/api/mtm/pipeline/attempts/${failedAttemptId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ season: 9877, calcuttaId: otherPoolId, confirmed: true }),
      },
    );
    assert.equal(response.status, 404);
    assert.equal(
      (await db.select().from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, failedAttemptId))).length,
      1,
    );
  });

  test("deletes one scoped non-current attempt and its evidence", async () => {
    const response = await fetch(
      `${baseUrl}/api/mtm/pipeline/attempts/${failedAttemptId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ season: 9877, calcuttaId: poolId, confirmed: true }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      deletedAttemptId: failedAttemptId,
      deletedVersionCount: 1,
      deletedPeriodSelectionCount: 0,
    });
    assert.equal(
      (await db.select().from(mtmSnapshotTable).where(eq(mtmSnapshotTable.id, failedAttemptId))).length,
      0,
    );
    assert.equal(
      (await db.select().from(mtmMarketQuoteTable).where(eq(mtmMarketQuoteTable.snapshotId, failedAttemptId))).length,
      0,
    );
  });
});