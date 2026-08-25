import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

let db;
let seasonsTable;
let teamsTable;
let teamSeasonAuctionsTable;
let teamResultsTable;
let app;

if (DATABASE_URL) {
  ({ db, seasonsTable, teamsTable, teamSeasonAuctionsTable, teamResultsTable } = await import("@workspace/db"));
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
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("period snapshot reporting", { skip: !DATABASE_URL || !ADMIN_KEY }, () => {
  let seasonYear;
  let seasonId;
  let teamId;
  let legacyTeamId;
  let server;
  let baseUrl;

  before(async () => {
    seasonYear = 1_700_000_000 + Math.floor(Math.random() * 100_000_000);
    const [season] = await db.insert(seasonsTable).values({
      year: seasonYear,
      isActive: false,
      isComplete: false,
      label: "Period snapshot integration fixture — safe to delete",
    }).returning();
    seasonId = season.id;
    const [team, legacyTeam] = await db.select({ id: teamsTable.id }).from(teamsTable).limit(2);
    assert.ok(team, "an NFL team fixture must exist");
    assert.ok(legacyTeam, "a second NFL team fixture must exist");
    teamId = team.id;
    legacyTeamId = legacyTeam.id;
    await db.insert(teamSeasonAuctionsTable).values({
      seasonId,
      teamId,
      bidAmount: "100.00",
    });
    await db.insert(teamResultsTable).values({ seasonId, teamId });
    await db.insert(teamSeasonAuctionsTable).values({
      seasonId,
      teamId: legacyTeamId,
      bidAmount: "300.00",
    });
    await db.insert(teamResultsTable).values({
      seasonId,
      teamId: legacyTeamId,
      wins: "12",
      realizedReturn: "999.00",
      markToMarket: "999.00",
    });
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await stopServer(server);
    if (seasonId) await db.delete(seasonsTable).where(eq(seasonsTable.id, seasonId));
  });

  test("enforces commissioner authorization for snapshot writes", async () => {
    const response = await fetch(`${baseUrl}/api/period-snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, seasonYear, periodSequence: 1, basis: "realized" }),
    });
    assert.equal(response.status, 401);

    const initializeResponse = await fetch(`${baseUrl}/api/period-snapshots/week-zero`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seasonYear }),
    });
    assert.equal(initializeResponse.status, 401);
  });

  test("automatically initializes complete immutable Week 0 baselines and opening returns", async () => {
    for (const basis of ["realized", "mtm"]) {
      const availability = await fetch(
        `${baseUrl}/api/results/availability?season=${seasonYear}&basis=${basis}`,
      );
      assert.equal(availability.status, 200);
      assert.deepEqual(await availability.json(), {
        latestPeriod: 0,
        previousPeriod: null,
      });
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_KEY}`,
    };
    const initialized = await fetch(`${baseUrl}/api/period-snapshots/week-zero`, {
      method: "POST",
      headers,
      body: JSON.stringify({ seasonYear }),
    });
    assert.equal(initialized.status, 200);
    assert.deepEqual(await initialized.json(), {
      seasonYear,
      periodSequence: 0,
      periodLabel: "Week 0",
      teamCount: 2,
      realizedSnapshotsWritten: 0,
      mtmSnapshotsWritten: 0,
      snapshotsWritten: 0,
      alreadyInitialized: true,
    });

    const realizedRows = await fetch(
      `${baseUrl}/api/results?season=${seasonYear}&period=0&basis=realized`,
    ).then((response) => response.json());
    assert.deepEqual(
      realizedRows.map((row) => ({
        teamId: row.teamId,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        ptDiff: row.ptDiff,
        realizedReturn: row.realizedReturn,
        netReturn: row.netReturn,
        markToMarket: row.markToMarket,
        ptsToBreakeven: row.ptsToBreakeven,
      })).sort((left, right) => left.teamId - right.teamId),
      [
        {
          teamId,
          wins: 0,
          losses: 0,
          ties: 0,
          ptDiff: 0,
          realizedReturn: 5.25,
          netReturn: -94.75,
          markToMarket: 5.25,
          ptsToBreakeven: -2705,
        },
        {
          teamId: legacyTeamId,
          wins: 0,
          losses: 0,
          ties: 0,
          ptDiff: 0,
          realizedReturn: 5.25,
          netReturn: -294.75,
          markToMarket: 5.25,
          ptsToBreakeven: -8415,
        },
      ].sort((left, right) => left.teamId - right.teamId),
    );

    const importedMtm = await fetch(`${baseUrl}/api/period-snapshots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        teamId,
        seasonYear,
        periodSequence: 0,
        basis: "mtm",
        wins: 2,
      }),
    });
    assert.equal(importedMtm.status, 200);

    const repeated = await fetch(`${baseUrl}/api/period-snapshots/week-zero`, {
      method: "POST",
      headers,
      body: JSON.stringify({ seasonYear }),
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), {
      seasonYear,
      periodSequence: 0,
      periodLabel: "Week 0",
      teamCount: 2,
      realizedSnapshotsWritten: 0,
      mtmSnapshotsWritten: 0,
      snapshotsWritten: 0,
      alreadyInitialized: true,
    });

    const mtmRows = await fetch(
      `${baseUrl}/api/results?season=${seasonYear}&period=0&basis=mtm`,
    ).then((response) => response.json());
    assert.equal(
      mtmRows.find((row) => row.teamId === teamId).markToMarket,
      5.95,
      "retrying must not replace a later imported MTM Week 0 snapshot",
    );
  });

  test("requires a Week 18 baseline before accepting a playoff snapshot", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_KEY}`,
    };
    const weekZero = await fetch(`${baseUrl}/api/period-snapshots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        teamId,
        seasonYear,
        periodSequence: 0,
        basis: "realized",
        wins: 0,
      }),
    });
    assert.equal(weekZero.status, 200);
    const response = await fetch(`${baseUrl}/api/period-snapshots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        teamId,
        seasonYear,
        periodSequence: 19,
        basis: "realized",
        wins: 12,
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Week 18 cumulative baseline/);
  });

  test("returns the requested basis and period rather than another snapshot basis", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_KEY}`,
    };
    const ruleResponse = await fetch(`${baseUrl}/api/payout-rules`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        seasonYear,
        rules: [
          { metric: "win", dollarsPerUnit: 10, playoffMultiplier: 1 },
          { metric: "tie", dollarsPerUnit: 5, playoffMultiplier: 1 },
          { metric: "pt_diff", dollarsPerUnit: 1, playoffMultiplier: 1 },
          { metric: "playoff_berth", dollarsPerUnit: 50, playoffMultiplier: 1 },
          { metric: "div_round", dollarsPerUnit: 100, playoffMultiplier: 1 },
          { metric: "conf_round", dollarsPerUnit: 200, playoffMultiplier: 1 },
          { metric: "sb_berth", dollarsPerUnit: 400, playoffMultiplier: 1 },
          { metric: "win_super_bowl", dollarsPerUnit: 800, playoffMultiplier: 1 },
        ],
      }),
    });
    assert.equal(ruleResponse.status, 200);

    for (const snapshot of [
      { periodSequence: 1, basis: "realized", wins: 1, playoffStatus: "alive" },
      { periodSequence: 2, basis: "realized", wins: 2, playoffStatus: "alive" },
      { periodSequence: 1, basis: "mtm", wins: 0.25, playoffStatus: "clinched" },
    ]) {
      const response = await fetch(`${baseUrl}/api/period-snapshots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ teamId, seasonYear, ...snapshot }),
      });
      assert.equal(response.status, 200);
    }

    const realizedAtWeekOne = await fetch(
      `${baseUrl}/api/results?season=${seasonYear}&period=1&basis=realized`,
    );
    const realizedRows = await realizedAtWeekOne.json();
    const realized = realizedRows.find((row) => row.teamId === teamId);
    assert.deepEqual(
      { wins: realized.wins, playoffBerth: realized.playoffBerth, realizedReturn: realized.realizedReturn },
      { wins: 0, playoffBerth: false, realizedReturn: 0 },
    );
    const missingSnapshotTeam = realizedRows.find((row) => row.teamId === legacyTeamId);
    assert.deepEqual(
      {
        wins: missingSnapshotTeam.wins,
        realizedReturn: missingSnapshotTeam.realizedReturn,
        markToMarket: missingSnapshotTeam.markToMarket,
      },
      { wins: 12, realizedReturn: 999, markToMarket: 999 },
    );

    const realizedAtWeekTwo = await fetch(
      `${baseUrl}/api/results?season=${seasonYear}&period=2&basis=realized`,
    );
    const weekTwoRows = await realizedAtWeekTwo.json();
    assert.equal(weekTwoRows.find((row) => row.teamId === teamId).wins, 0);

    const mtmAtWeekOne = await fetch(
      `${baseUrl}/api/results?season=${seasonYear}&period=1&basis=mtm`,
    );
    const mtmRows = await mtmAtWeekOne.json();
    const mtm = mtmRows.find((row) => row.teamId === teamId);
    assert.deepEqual(
      { wins: mtm.wins, playoffBerth: mtm.playoffBerth, markToMarket: mtm.markToMarket },
      { wins: 0, playoffBerth: false, markToMarket: 0 },
    );
  });
});