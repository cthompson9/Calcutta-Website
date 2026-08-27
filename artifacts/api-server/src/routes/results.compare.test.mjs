import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { ensureNflSportPeriods } from "../lib/calcuttaReturns.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const MCP_KEY = process.env.MCP_API_KEY;

let db;
let seasonsTable;
let teamsTable;
let biddersTable;
let consortiaTable;
let consortiumMembershipsTable;
let teamSeasonAuctionsTable;
let teamResultsTable;
let payoutRulesTable;
let calcuttasTable;
let calcuttaEntriesTable;
let sportPeriodsTable;
let teamPeriodSnapshotsTable;
let snapshotMetricsTable;
let positionsTable;
let app;
let runDatabaseMigrations;

if (DATABASE_URL) {
  ({
    db,
    seasonsTable,
    teamsTable,
    biddersTable,
    consortiaTable,
    consortiumMembershipsTable,
    teamSeasonAuctionsTable,
    teamResultsTable,
    payoutRulesTable,
    calcuttasTable,
    calcuttaEntriesTable,
    sportPeriodsTable,
    teamPeriodSnapshotsTable,
    snapshotMetricsTable,
    positionsTable,
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
    ? body.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length)
    : body;
  assert.ok(json, body);
  return JSON.parse(json);
}

function mcpText(response) {
  return response.result?.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("cross-Calcutta return comparison", { skip: !DATABASE_URL }, () => {
  let years;
  let seasonIds;
  let bidder;
  let server;
  let baseUrl;
  let fixtureId;
  let historicConsortium;
  let currentConsortium;
  let teamId;
  let teamName;
  let secondaryCalcuttaId;

  before(async () => {
    await runDatabaseMigrations();
    fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const baseYear = 3000 + (Date.now() % 3000);
    years = [baseYear, baseYear + 1];
    const seasons = await db
      .insert(seasonsTable)
      .values(
        years.map((year) => ({
          year,
          isActive: false,
          isComplete: false,
          label: `Comparison fixture ${year}`,
        })),
      )
      .returning();
    seasonIds = new Map(seasons.map((season) => [season.year, season.id]));
    [bidder] = await db
      .insert(biddersTable)
      .values({ name: `Comparison bidder ${fixtureId}` })
      .returning();
    [historicConsortium] = await db
      .insert(consortiaTable)
      .values({ name: `Historic comparison group ${fixtureId}` })
      .returning();
    [currentConsortium] = await db
      .insert(consortiaTable)
      .values({ name: `Current comparison group ${fixtureId}` })
      .returning();
    await db.insert(consortiumMembershipsTable).values([
      {
        bidderId: bidder.id,
        consortiumId: historicConsortium.id,
        fromDate: `${years[0]}-01-01`,
        toDate: `${years[1]}-01-01`,
      },
      {
        bidderId: bidder.id,
        consortiumId: currentConsortium.id,
        fromDate: `${years[1]}-01-01`,
      },
    ]);
    const [team] = await db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable).limit(1);
    assert.ok(team, "an NFL team fixture must exist");
    teamId = team.id;
    teamName = team.name;
    for (const year of years) {
      const seasonId = seasonIds.get(year);
      await db.insert(teamSeasonAuctionsTable).values({
        seasonId,
        teamId: team.id,
        bidAmount: "100.00",
      });
      const [calcutta] = await db.insert(calcuttasTable).values({
        seasonId,
        year,
        name: `${year} NFL Calcutta`,
        sport: "NFL",
        isCanonical: true,
        asOfDate: `${year}-08-01`,
      }).returning();
      const [entry] = await db.insert(calcuttaEntriesTable).values({
        calcuttaId: calcutta.id,
        teamId: team.id,
        realizedReturn: "125.00",
        markToMarket: "140.00",
      }).returning();
      await db.insert(positionsTable).values({
        entryId: entry.id,
        bidderId: bidder.id,
        ownershipShare: "1.000000",
        source: "primary",
        costBasis: "100.00",
      });
      await db.insert(teamResultsTable).values({
        seasonId,
        teamId: team.id,
        realizedReturn: "999.00",
        markToMarket: "888.00",
      });
    }

    const [secondaryCalcutta] = await db.insert(calcuttasTable).values({
      seasonId: seasonIds.get(years[0]),
      year: years[0],
      name: `${years[0]} secondary NFL Calcutta ${fixtureId}`,
      sport: "NFL",
      isCanonical: false,
      asOfDate: `${years[0]}-08-02`,
    }).returning();
    secondaryCalcuttaId = secondaryCalcutta.id;
    const [secondaryEntry] = await db.insert(calcuttaEntriesTable).values({
      calcuttaId: secondaryCalcuttaId,
      teamId,
      realizedReturn: "333.00",
      markToMarket: "444.00",
    }).returning();
    await db.insert(positionsTable).values({
      entryId: secondaryEntry.id,
      bidderId: bidder.id,
      ownershipShare: "1.000000",
      source: "primary",
      costBasis: "200.00",
    });

    const [newerCalcutta] = await db
      .select({ id: calcuttasTable.id })
      .from(calcuttasTable)
      .where(eq(calcuttasTable.seasonId, seasonIds.get(years[1])));
    await db.insert(payoutRulesTable).values([
      ["win", "10.00"], ["tie", "5.00"], ["pt_diff", "1.00"],
      ["playoff_berth", "50.00"], ["div_round", "100.00"],
      ["conf_round", "200.00"], ["sb_berth", "400.00"], ["win_super_bowl", "800.00"],
    ].map(([metric, dollarsPerUnit]) => ({
      calcuttaId: newerCalcutta.id,
      metric,
      dollarsPerUnit,
      playoffMultiplier: "1.00",
    })));
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (seasonIds) {
      await db
        .delete(seasonsTable)
        .where(inArray(seasonsTable.id, [...seasonIds.values()]));
    }
    if (bidder) await db.delete(biddersTable).where(eq(biddersTable.id, bidder.id));
  });

  test("uses live net-MTM values with each Calcutta's historical roster and flags missing snapshots", async () => {
    const response = await fetch(
      `${baseUrl}/api/results/compare?seasons=${years.join(",")}&basis=mtm&groupBy=bidder`,
    );
    assert.equal(response.status, 200);
    const comparison = await response.json();
    const row = comparison.rows.find((item) => item.bidderId === bidder.id);
    assert.ok(row);
    assert.equal(row.calcuttas[0].consortium, historicConsortium.name);
    assert.equal(row.calcuttas[0].totalNetMtm, -100);
    assert.equal(row.calcuttas[0].signedShare, 1);
    assert.equal(row.calcuttas[1].consortium, currentConsortium.name);
    assert.equal(row.calcuttas[1].snapshotAvailable, false);
    assert.equal(row.calcuttas[1].snapshotTeamCount, 0);
    assert.equal(row.calcuttas[1].totalNetMtm, -100);
    assert.equal(row.aggregate.snapshotAvailable, false);
    assert.equal(row.aggregate.missingSnapshotCount, 2);
  });

  test("groups historical and current consortium rollups independently", async () => {
    const historical = await fetch(
      `${baseUrl}/api/results/compare?seasons=${years.join(",")}&groupBy=consortium`,
    );
    const historicalRows = (await historical.json()).rows;
    assert.ok(historicalRows.some((row) => row.name === historicConsortium.name));

    const current = await fetch(
      `${baseUrl}/api/results/compare?seasons=${years.join(",")}&groupBy=consortium&membershipView=current`,
    );
    const currentRows = (await current.json()).rows;
    assert.ok(currentRows.some((row) => row.name === currentConsortium.name));
    assert.ok(!currentRows.some((row) => row.name === historicConsortium.name));
  });

  test("legacy MCP HTTP endpoints never expose stored entry return sentinels", async () => {
    const query = (path, params) => fetch(
      `${baseUrl}/api${path}?${new URLSearchParams(params)}`,
    ).then(async (response) => {
      assert.equal(response.status, 200);
      return (await response.json()).value;
    });

    assert.equal(await query("/mcp/get_team_return", {
      team: teamName,
      season: String(years[0]),
    }), null);
    assert.equal(await query("/mcp/get_team_return", {
      team: teamName,
      season: String(years[0]),
      calcuttaId: String(secondaryCalcuttaId),
    }), null);
    assert.equal(await query("/mcp/get_team_mtm", {
      team: teamName,
      season: String(years[0]),
    }), null);
    assert.equal(await query("/mcp/get_team_mtm", {
      team: teamName,
      season: String(years[0]),
      calcuttaId: String(secondaryCalcuttaId),
    }), null);
    assert.equal(await query("/mcp/get_owner_return", {
      owner: bidder.name,
      season: String(years[0]),
      calcuttaId: String(secondaryCalcuttaId),
    }), null);
    assert.equal(await query("/mcp/get_owner_mtm", {
      owner: bidder.name,
      season: String(years[0]),
      calcuttaId: String(secondaryCalcuttaId),
    }), null);
    const response = await fetch(`${baseUrl}/api/mcp/get_team_return?${new URLSearchParams({
      team: teamName,
      season: String(years[0]),
    })}`);
    assert.equal(await response.text(), JSON.stringify({ value: null }));
  });

  test("flags a stale selected-basis snapshot instead of mixing periods", async () => {
    const [freshTeam] = await db
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(sql`${teamsTable.id} != ${teamId}`)
      .limit(1);
    assert.ok(freshTeam, "a second NFL team fixture must exist");
    const newerSeasonId = seasonIds.get(years[1]);
    await db.insert(teamSeasonAuctionsTable).values({
      seasonId: newerSeasonId,
      teamId: freshTeam.id,
      bidAmount: "100.00",
    });
    const [newerCalcutta] = await db
      .select({ id: calcuttasTable.id })
      .from(calcuttasTable)
      .where(eq(calcuttasTable.seasonId, newerSeasonId));
    const [freshEntry] = await db.insert(calcuttaEntriesTable).values({
      calcuttaId: newerCalcutta.id,
      teamId: freshTeam.id,
    }).returning();
    await db.insert(positionsTable).values({
      entryId: freshEntry.id,
      bidderId: bidder.id,
      ownershipShare: "1.000000",
      source: "primary",
      costBasis: "100.00",
    });
    const entries = await db
      .select({ id: calcuttaEntriesTable.id, teamId: calcuttaEntriesTable.teamId })
      .from(calcuttaEntriesTable)
      .where(eq(calcuttaEntriesTable.calcuttaId, newerCalcutta.id));
    const staleEntry = entries.find((entry) => entry.teamId === teamId);
    const freshSnapshotEntry = entries.find((entry) => entry.teamId === freshTeam.id);
    assert.ok(staleEntry);
    assert.ok(freshSnapshotEntry);

    await ensureNflSportPeriods(db);
    const periods = await db
      .select({ id: sportPeriodsTable.id, sequence: sportPeriodsTable.sequence })
      .from(sportPeriodsTable)
      .where(inArray(sportPeriodsTable.sequence, [1, 2]));
    const periodId = new Map(periods.map((period) => [period.sequence, period.id]));
    const realizedMetricRows = (entryId, selectedPeriodId, wins) => {
      const values = {
        wins,
        losses: 0,
        ties: 0,
        pt_diff: 0,
        ordinary_wins: wins,
        marquee_wins: 0,
        ordinary_ties: 0,
        marquee_ties: 0,
        ordinary_pt_diff: 0,
        marquee_pt_diff: 0,
      };
      return Object.entries(values).map(([metric, value]) => ({
        calcuttaId: newerCalcutta.id,
        entryId,
        periodId: selectedPeriodId,
        basis: "realized",
        metric,
        value: String(value),
        source: "test",
      }));
    };
    await db.insert(snapshotMetricsTable).values([
      ...realizedMetricRows(staleEntry.id, periodId.get(1), 1),
      ...realizedMetricRows(freshSnapshotEntry.id, periodId.get(2), 2),
    ]);

    const response = await fetch(
      `${baseUrl}/api/results/compare?seasons=${years.join(",")}&basis=realized&period=2&groupBy=bidder`,
    );
    assert.equal(response.status, 200);
    const comparison = await response.json();
    const row = comparison.rows.find((item) => item.bidderId === bidder.id);
    const newerCell = row.calcuttas[1];
    assert.equal(newerCell.throughPeriod, 2);
    assert.equal(newerCell.snapshotAvailable, false);
    assert.equal(newerCell.snapshotTeamCount, 0);
    assert.equal(newerCell.totalRealizedReturn, 0);
    assert.equal(row.aggregate.snapshotAvailable, false);

    const latestResponse = await fetch(
      `${baseUrl}/api/results/compare?seasons=${years.join(",")}&basis=realized&groupBy=bidder`,
    );
    const latestComparison = await latestResponse.json();
    const latestRow = latestComparison.rows.find((item) => item.bidderId === bidder.id);
    assert.equal(latestRow.calcuttas[1].throughPeriod, null);
    assert.equal(latestRow.calcuttas[1].snapshotAvailable, false);
    assert.equal(latestRow.calcuttas[1].snapshotTeamCount, 0);
  });

  test("rejects a selected season without a canonical NFL Calcutta", async () => {
    const absentYear = years[1] + 1;
    const [absentSeason] = await db
      .insert(seasonsTable)
      .values({
        year: absentYear,
        isActive: false,
        isComplete: false,
        label: `No Calcutta ${fixtureId}`,
      })
      .returning();
    try {
      const response = await fetch(
        `${baseUrl}/api/results/compare?seasons=${years[0]},${absentYear}`,
      );
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /No canonical NFL Calcutta/);
    } finally {
      await db.delete(seasonsTable).where(eq(seasonsTable.id, absentSeason.id));
    }
  });

  test("exposes the bidder rollup through MCP", { skip: !MCP_KEY }, async () => {
    const tools = await mcpRequest(baseUrl, 1, "tools/list");
    assert.ok(tools.result.tools.some((tool) => tool.name === "compare_calcutta_returns"));

    const response = await mcpRequest(baseUrl, 2, "tools/call", {
      name: "compare_calcutta_returns",
      arguments: { seasons: years, groupBy: "bidder", basis: "realized" },
    });
    const comparison = JSON.parse(mcpText(response));
    assert.equal(comparison.groupBy, "bidder");
    assert.equal(comparison.calcuttas.length, 2);

    const selectedTeamReturn = await mcpRequest(baseUrl, 20, "tools/call", {
      name: "get_team_return",
      arguments: {
        team: teamName,
        season: years[0],
        calcuttaId: secondaryCalcuttaId,
      },
    });
    assert.equal(mcpText(selectedTeamReturn), "null");
    const selectedOwnerMtm = await mcpRequest(baseUrl, 21, "tools/call", {
      name: "get_owner_mtm",
      arguments: {
        owner: bidder.name,
        season: years[0],
        calcuttaId: secondaryCalcuttaId,
      },
    });
    assert.equal(mcpText(selectedOwnerMtm), "null");

    const absentYear = years[1] + 1;
    const [absentSeason] = await db
      .insert(seasonsTable)
      .values({
        year: absentYear,
        isActive: false,
        isComplete: false,
        label: `No MCP Calcutta ${fixtureId}`,
      })
      .returning();
    try {
      const rejected = await mcpRequest(baseUrl, 3, "tools/call", {
        name: "compare_calcutta_returns",
        arguments: { seasons: [years[0], absentYear] },
      });
      assert.match(mcpText(rejected), /No canonical NFL Calcutta/);
    } finally {
      await db.delete(seasonsTable).where(eq(seasonsTable.id, absentSeason.id));
    }
  });
});