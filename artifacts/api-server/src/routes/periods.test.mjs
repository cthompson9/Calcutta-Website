import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const MCP_KEY = process.env.MCP_API_KEY;

let db;
let seasonsTable;
let teamsTable;
let teamSeasonAuctionsTable;
let teamResultsTable;
let calcuttasTable;
let calcuttaEntriesTable;
let positionsTable;
let biddersTable;
let payoutRulesTable;
let sportPeriodsTable;
let teamPeriodSnapshotsTable;
let snapshotMetricsTable;
let app;

if (DATABASE_URL) {
  ({
    db,
    seasonsTable,
    teamsTable,
    teamSeasonAuctionsTable,
    teamResultsTable,
    calcuttasTable,
    calcuttaEntriesTable,
    positionsTable,
    biddersTable,
    payoutRulesTable,
    sportPeriodsTable,
    teamPeriodSnapshotsTable,
    snapshotMetricsTable,
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
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function mcpRequest(baseUrl, id, method, params = {}) {
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${MCP_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const json = body.trim().startsWith("event:")
    ? body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : body;
  return JSON.parse(json);
}

function mcpText(response) {
  return response.result?.content?.find((item) => item.type === "text")?.text ?? "";
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
    const [calcutta] = await db.insert(calcuttasTable).values({
      seasonId,
      year: seasonYear,
      name: `${seasonYear} NFL Calcutta`,
      sport: "NFL",
      isCanonical: true,
    }).returning();
    const entries = await db.insert(calcuttaEntriesTable).values([
      { calcuttaId: calcutta.id, teamId },
      {
        calcuttaId: calcutta.id,
        teamId: legacyTeamId,
        realizedReturn: "999.00",
        markToMarket: "999.00",
      },
    ]).returning();
    const [bidder] = await db.select({ id: biddersTable.id }).from(biddersTable).limit(1);
    assert.ok(bidder, "an NFL bidder fixture must exist");
    await db.insert(positionsTable).values(entries.map((entry) => ({
      entryId: entry.id,
      bidderId: bidder.id,
      ownershipShare: "1.000000",
      source: "primary",
      costBasis: entry.teamId === teamId ? "100.00" : "300.00",
    })));
    ({ server, baseUrl } = await startServer(app));
  });

  test("protects and returns entry-return discrepancy diagnostics for the selected season", async () => {
    const unauthorized = await fetch(
      `${baseUrl}/api/entry-return-diagnostics?season=${seasonYear}`,
    );
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });

    const invalidSelection = await fetch(
      `${baseUrl}/api/entry-return-diagnostics?season=${seasonYear}&calcuttaId=0`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    );
    assert.equal(invalidSelection.status, 400);

    const success = await fetch(
      `${baseUrl}/api/entry-return-diagnostics?season=${seasonYear}`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    );
    assert.equal(success.status, 200);
    const audit = await success.json();
    assert.equal(typeof audit.ok, "boolean");
    assert.equal(typeof audit.calcuttaId, "number");
    assert.equal(typeof audit.auditedEntries, "number");
    assert.ok(Array.isArray(audit.issues));
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

  test("saves a configurable CFB rubric through the commissioner endpoint", async () => {
    const [cfbCalcutta] = await db.insert(calcuttasTable).values({
      seasonId,
      year: seasonYear,
      name: `${seasonYear} CFB Calcutta`,
      sport: "CFB",
      competitionFormat: "CFB_REGULAR_SEASON",
      isCanonical: true,
    }).returning({ id: calcuttasTable.id });
    const response = await fetch(`${baseUrl}/api/payout-rules`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        seasonYear,
        calcuttaId: cfbCalcutta.id,
        startingPoints: 20,
        normalizationDenominator: 100,
        rules: [
          { metric: "win", dollarsPerUnit: 10, playoffMultiplier: 1 },
          { metric: "loss", dollarsPerUnit: -2, playoffMultiplier: 1 },
          { metric: "tie", dollarsPerUnit: 4, playoffMultiplier: 1 },
          { metric: "pt_diff", dollarsPerUnit: 0.5, playoffMultiplier: 1 },
        ],
      }),
    });
    assert.equal(response.status, 200, await response.text());
    const { hasConfiguredPayoutRulesForCalcutta } = await import(
      "../lib/calcuttaReturns.ts"
    );
    assert.equal(
      await hasConfiguredPayoutRulesForCalcutta(cfbCalcutta.id),
      true,
    );
    const rows = await fetch(
      `${baseUrl}/api/payout-rules?season=${seasonYear}&calcuttaId=${cfbCalcutta.id}`,
    ).then((result) => result.json());
    assert.deepEqual(
      rows.map((row) => row.metric).sort(),
      ["loss", "pt_diff", "tie", "win"],
    );
    await db.delete(calcuttasTable).where(eq(calcuttasTable.id, cfbCalcutta.id));
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
      { wins: 12, realizedReturn: 0, markToMarket: 0 },
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

  test("MCP snapshot writes become authoritative only with complete pool coverage", { skip: !MCP_KEY }, async () => {
    const teamRows = await db
      .select({ id: teamsTable.id, name: teamsTable.name })
      .from(teamsTable);
    const names = new Map(teamRows.map((team) => [team.id, team.name]));
    for (const [index, selectedTeamId] of [teamId, legacyTeamId].entries()) {
      const response = await mcpRequest(baseUrl, 100 + index, "tools/call", {
        name: "set_team_period_snapshot",
        arguments: {
          team: names.get(selectedTeamId),
          season: seasonYear,
          period: 3,
          basis: "mtm",
          wins: index + 1,
          adminKey: ADMIN_KEY,
        },
      });
      const result = JSON.parse(mcpText(response));
      assert.equal(result.period, 3);
      if (index === 1) assert.ok(result.grossReturn > 0);
    }

    const available = await fetch(
      `${baseUrl}/api/results/availability?season=${seasonYear}&basis=mtm`,
    ).then((response) => response.json());
    assert.equal(available.latestPeriod, 3);

    const [entry] = await db
      .select({ id: calcuttaEntriesTable.id, calcuttaId: calcuttaEntriesTable.calcuttaId })
      .from(calcuttaEntriesTable)
      .innerJoin(
        calcuttasTable,
        eq(calcuttasTable.id, calcuttaEntriesTable.calcuttaId),
      )
      .where(and(
        eq(calcuttaEntriesTable.teamId, teamId),
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.isCanonical, true),
      ))
      .limit(1);
    const [period] = await db
      .select({ id: sportPeriodsTable.id })
      .from(sportPeriodsTable)
      .where(and(
        eq(sportPeriodsTable.sport, "NFL"),
        eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
        eq(sportPeriodsTable.sequence, 3),
      ))
      .limit(1);
    await db.delete(snapshotMetricsTable).where(and(
      eq(snapshotMetricsTable.calcuttaId, entry.calcuttaId),
      eq(snapshotMetricsTable.entryId, entry.id),
      eq(snapshotMetricsTable.periodId, period.id),
      eq(snapshotMetricsTable.basis, "mtm"),
      eq(snapshotMetricsTable.metric, "win_super_bowl"),
    ));
    const incomplete = await fetch(
      `${baseUrl}/api/results/availability?season=${seasonYear}&basis=mtm`,
    ).then((response) => response.json());
    assert.notEqual(incomplete.latestPeriod, 3);
  });

  test("fans one season game ledger rebuild out to every existing NFL Calcutta", async () => {
    const [alternate] = await db.insert(calcuttasTable).values({
      seasonId,
      year: seasonYear,
      name: `${seasonYear} Alternate game-ledger NFL Calcutta`,
      sport: "NFL",
      isCanonical: false,
    }).returning();
    const alternateEntries = await db.insert(calcuttaEntriesTable).values([
      { calcuttaId: alternate.id, teamId },
      { calcuttaId: alternate.id, teamId: legacyTeamId },
    ]).returning();
    const [bidder] = await db.select({ id: biddersTable.id }).from(biddersTable).limit(1);
    assert.ok(bidder);
    await db.insert(positionsTable).values(alternateEntries.map((entry) => ({
      entryId: entry.id,
      bidderId: bidder.id,
      ownershipShare: "1.000000",
      source: "primary",
      costBasis: entry.teamId === teamId ? "1000.00" : "3000.00",
    })));
    await db.insert(payoutRulesTable).values([
      ["win", "10.00"], ["tie", "5.00"], ["pt_diff", "1.00"],
      ["playoff_berth", "50.00"], ["div_round", "100.00"],
      ["conf_round", "200.00"], ["sb_berth", "400.00"], ["win_super_bowl", "800.00"],
    ].map(([metric, dollarsPerUnit]) => ({
      calcuttaId: alternate.id,
      metric,
      dollarsPerUnit,
      playoffMultiplier: "1.00",
    })));

    const response = await fetch(`${baseUrl}/api/nfl-games`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        seasonYear,
        periodSequence: 1,
        source: "integration",
        sourceGameId: `two-pool-${seasonId}`,
        homeTeamId: teamId,
        awayTeamId: legacyTeamId,
        homeScore: 27,
        awayScore: 20,
        actualKickoffAt: "2025-09-07T17:00:00.000Z",
      }),
    });
    assert.equal(response.status, 201);

    const [canonicalResponse, alternateResponse] = await Promise.all([
      fetch(`${baseUrl}/api/results?season=${seasonYear}&period=1&basis=realized`),
      fetch(`${baseUrl}/api/results?season=${seasonYear}&calcuttaId=${alternate.id}&period=1&basis=realized`),
    ]);
    assert.equal(canonicalResponse.status, 200);
    assert.equal(alternateResponse.status, 200);
    const canonical = (await canonicalResponse.json()).find((row) => row.teamId === teamId);
    const selected = (await alternateResponse.json()).find((row) => row.teamId === teamId);
    assert.deepEqual(
      { wins: canonical.wins, ptDiff: canonical.ptDiff, cost: canonical.cost },
      { wins: 1, ptDiff: 7, cost: 100 },
    );
    assert.deepEqual(
      { wins: selected.wins, ptDiff: selected.ptDiff, cost: selected.cost },
      { wins: 1, ptDiff: 7, cost: 1000 },
    );
    assert.ok(selected.realizedReturn > canonical.realizedReturn);
    assert.ok(Math.abs(selected.realizedReturn - canonical.realizedReturn * 10) < 0.02);
  });

  test("calculates a completed noncanonical Calcutta from its own costs and snapshots", async () => {
    await db
      .update(seasonsTable)
      .set({ isComplete: true })
      .where(eq(seasonsTable.id, seasonId));
    const [alternate] = await db.insert(calcuttasTable).values({
      seasonId,
      year: seasonYear,
      name: `${seasonYear} Alternate completed NFL Calcutta`,
      sport: "NFL",
      isCanonical: false,
    }).returning();
    const [entry] = await db.insert(calcuttaEntriesTable).values({
      calcuttaId: alternate.id,
      teamId,
      realizedReturn: "777.00",
    }).returning();
    const [bidder] = await db.select({ id: biddersTable.id }).from(biddersTable).limit(1);
    assert.ok(bidder);
    await db.insert(positionsTable).values({
      entryId: entry.id,
      bidderId: bidder.id,
      ownershipShare: "1.000000",
      source: "primary",
      costBasis: "2000.00",
    });
    await db.insert(payoutRulesTable).values([
      ["win", "10.00"], ["tie", "5.00"], ["pt_diff", "1.00"],
      ["playoff_berth", "50.00"], ["div_round", "100.00"],
      ["conf_round", "200.00"], ["sb_berth", "400.00"], ["win_super_bowl", "800.00"],
    ].map(([metric, dollarsPerUnit]) => ({
      calcuttaId: alternate.id,
      metric,
      dollarsPerUnit,
      playoffMultiplier: "1.00",
    })));
    const [canonicalResponse, alternateResponse] = await Promise.all([
      fetch(`${baseUrl}/api/results?season=${seasonYear}&period=0&basis=realized`),
      fetch(`${baseUrl}/api/results?season=${seasonYear}&calcuttaId=${alternate.id}&period=0&basis=realized`),
    ]);
    assert.equal(canonicalResponse.status, 200);
    assert.equal(alternateResponse.status, 200);
    const canonical = (await canonicalResponse.json()).find((row) => row.teamId === teamId);
    const selected = (await alternateResponse.json()).find((row) => row.teamId === teamId);
    assert.equal(canonical.realizedReturn, 5.25);
    assert.equal(canonical.cost, 100);
    assert.equal(selected.realizedReturn, 26.27);
    assert.equal(selected.netReturn, -1973.73);
    assert.equal(selected.cost, 2000);

    const availability = await fetch(
      `${baseUrl}/api/results/availability?season=${seasonYear}&calcuttaId=${alternate.id}&basis=realized`,
    );
    assert.equal(availability.status, 200);
    assert.deepEqual(await availability.json(), {
      latestPeriod: 0,
      previousPeriod: null,
    });
  });
});