import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const MCP_KEY = process.env.MCP_API_KEY;

let app;
let db;
let runDatabaseMigrations;
let seasonsTable;
let teamsTable;
let biddersTable;
let consortiaTable;
let consortiumMembershipsTable;
let calcuttasTable;
let calcuttaEntriesTable;
let positionsTable;
let payoutRulesTable;
let eventsTable;
let eventMarketSnapshotsTable;
let eventProjectionsTable;
let snapshotMetricsTable;
let sportPeriodsTable;

if (DATABASE_URL) {
  ({
    db,
    runDatabaseMigrations,
    seasonsTable,
    teamsTable,
    biddersTable,
    consortiaTable,
    consortiumMembershipsTable,
    calcuttasTable,
    calcuttaEntriesTable,
    positionsTable,
    payoutRulesTable,
    eventsTable,
    eventMarketSnapshotsTable,
    eventProjectionsTable,
    snapshotMetricsTable,
    sportPeriodsTable,
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
    ? body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : body;
  return JSON.parse(json);
}

function mcpText(response) {
  return response.result?.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("V2.1 agent read API", { skip: !DATABASE_URL }, () => {
  let server;
  let baseUrl;
  let season;
  let calcutta;
  let otherCalcutta;
  let owner;
  let similarOwner;
  let buyer;
  let consortium;
  let teamA;
  let teamB;
  let event;
  let period;

  before(async () => {
    await runDatabaseMigrations();
    const fixture = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const year = 4000 + (Date.now() % 1000);
    [teamA, teamB] = await db.select().from(teamsTable).limit(2);
    assert.ok(teamA && teamB);
    [season] = await db.insert(seasonsTable).values({
      year,
      label: `V2 agent fixture ${fixture}`,
      isActive: false,
      isComplete: false,
    }).returning();
    [calcutta] = await db.insert(calcuttasTable).values({
      seasonId: season.id,
      year,
      name: `V2 canonical ${fixture}`,
      sport: "NFL",
      isCanonical: true,
      asOfDate: `${year}-08-01`,
    }).returning();
    [otherCalcutta] = await db.insert(calcuttasTable).values({
      seasonId: season.id,
      year,
      name: `V2 alternate ${fixture}`,
      sport: "NFL",
      isCanonical: false,
      asOfDate: `${year}-08-02`,
    }).returning();
    [owner, similarOwner, buyer] = await db.insert(biddersTable).values([
      { name: `V2 Alpha ${fixture}` },
      { name: `V2 Alpine ${fixture}` },
      { name: `V2 Buyer ${fixture}` },
    ]).returning();
    [consortium] = await db.insert(consortiaTable).values({
      name: `V2 consortium ${fixture}`,
    }).returning();
    await db.insert(consortiumMembershipsTable).values({
      bidderId: owner.id,
      consortiumId: consortium.id,
      fromDate: `${year}-01-01`,
    });

    const [entryA, entryB, otherEntry] = await db.insert(calcuttaEntriesTable).values([
      { calcuttaId: calcutta.id, teamId: teamA.id, realizedReturn: "200", markToMarket: "260" },
      { calcuttaId: calcutta.id, teamId: teamB.id, realizedReturn: "80", markToMarket: "120" },
      { calcuttaId: otherCalcutta.id, teamId: teamA.id, realizedReturn: "999", markToMarket: "999" },
    ]).returning();
    await db.insert(positionsTable).values([
      { entryId: entryA.id, bidderId: owner.id, ownershipShare: "1", source: "primary", costBasis: "100" },
      { entryId: entryA.id, bidderId: owner.id, ownershipShare: "-1.25", source: "trade", costBasis: "-125" },
      { entryId: entryA.id, bidderId: buyer.id, ownershipShare: "1.25", source: "trade", costBasis: "125" },
      { entryId: entryB.id, bidderId: owner.id, ownershipShare: "1", source: "primary", costBasis: "50" },
      { entryId: otherEntry.id, bidderId: similarOwner.id, ownershipShare: "1", source: "primary", costBasis: "500" },
    ]);
    await db.insert(payoutRulesTable).values([
      ["win", "10"], ["tie", "5"], ["pt_diff", "1"], ["playoff_berth", "50"],
      ["div_round", "100"], ["conf_round", "200"], ["sb_berth", "400"], ["win_super_bowl", "800"],
    ].map(([metric, dollarsPerUnit]) => ({
      calcuttaId: calcutta.id,
      metric,
      dollarsPerUnit,
      playoffMultiplier: "1",
    })));
    [period] = await db.select().from(sportPeriodsTable).where(eq(sportPeriodsTable.sequence, 1)).limit(1);
    await db.insert(snapshotMetricsTable).values({
      calcuttaId: calcutta.id,
      entryId: entryA.id,
      periodId: period.id,
      basis: "realized",
      metric: "wins",
      value: "1",
      source: "test",
    });
    [event] = await db.insert(eventsTable).values({
      seasonId: season.id,
      sport: "NFL",
      competition: "NFL_REGULAR_SEASON",
      source: "espn",
      sourceEventId: `v2-${fixture}`,
      week: 1,
      eventDate: `${year}-09-07`,
      kickoffAt: new Date(`${year}-09-07T17:00:00.000Z`),
      awayTeamId: teamA.id,
      homeTeamId: teamB.id,
      venue: "Fixture Field",
      network: "TEST",
      status: "scheduled",
    }).returning();
    await db.insert(eventsTable).values({
      seasonId: season.id,
      sport: "CFB",
      competition: "CFB_REGULAR_SEASON",
      source: "espn",
      sourceEventId: event.sourceEventId,
      week: 1,
      eventDate: `${year}-09-07`,
      kickoffAt: new Date(`${year}-09-07T17:00:00.000Z`),
      awayTeamId: teamB.id,
      homeTeamId: teamA.id,
      venue: "College Fixture Field",
      network: "TEST",
      status: "scheduled",
    });
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (season) await db.delete(seasonsTable).where(eq(seasonsTable.id, season.id));
    if (owner) await db.delete(biddersTable).where(inArray(biddersTable.id, [owner.id, similarOwner.id, buyer.id]));
    if (consortium) await db.delete(consortiaTable).where(eq(consortiaTable.id, consortium.id));
  });

  test("returns signed, trade-aware owner positions and isolates Calcuttas", async () => {
    const response = await fetch(
      `${baseUrl}/api/v2/owner/portfolio?season=${season.year}&owner=${encodeURIComponent(owner.name)}&calcuttaId=${calcutta.id}`,
    );
    assert.equal(response.status, 200);
    const portfolio = await response.json();
    assert.equal(portfolio.calcutta_id, calcutta.id);
    assert.equal(portfolio.calculation_status, "unavailable");
    const short = portfolio.teams.find((row) => row.team_id === teamA.id);
    assert.equal(short.ownership_percentage, -25);
    assert.equal(short.cost_basis, -25);
    assert.equal(short.realized_return, null);
    assert.ok(portfolio.teams.every((row) => row.realized_return !== 999));
  });

  test("rejects ambiguous partial names and accepts unique partial names", async () => {
    const ambiguous = await fetch(
      `${baseUrl}/api/v2/owner/summary?season=${season.year}&owner=V2&calcuttaId=${calcutta.id}`,
    );
    assert.equal(ambiguous.status, 404);
    assert.match((await ambiguous.json()).error, /ambiguous/i);

    const unique = await fetch(
      `${baseUrl}/api/v2/owner/summary?season=${season.year}&owner=${encodeURIComponent(`Alpha ${String(owner.name).split(" ").at(-1)}`)}&calcuttaId=${calcutta.id}`,
    );
    assert.equal(unique.status, 200);
    assert.equal((await unique.json()).owner, owner.name);
  });

  test("filters schedules on both home and away teams and preserves missing market data as null", async () => {
    const response = await fetch(
      `${baseUrl}/api/v2/schedule?season=${season.year}&team=${encodeURIComponent(teamB.name)}&week=1&include_market=true&include_projection=true`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.games.length, 1);
    assert.equal(payload.games[0].game_id, `espn:${event.sourceEventId}`);
    assert.equal(payload.games[0].market, null);
    assert.equal(payload.games[0].projection, null);
    assert.equal(
      payload.games[0].point_diff_multiplier,
      payload.games[0].is_marquee ? 2 : 1,
    );
    const abbreviation = payload.games[0].home_team === teamB.name
      ? payload.games[0].home_abbreviation
      : payload.games[0].away_abbreviation;
    const abbreviationResponse = await fetch(
      `${baseUrl}/api/v2/schedule?season=${season.year}&team=${abbreviation}&week=1`,
    );
    assert.equal(abbreviationResponse.status, 200);
    assert.equal((await abbreviationResponse.json()).games.length, 1);
  });

  test("reconciles game detail and team schedule with the schedule identity", async () => {
    const detail = await fetch(
      `${baseUrl}/api/v2/game?season=${season.year}&game_id=${encodeURIComponent(`espn:${event.sourceEventId}`)}`,
    );
    assert.equal(detail.status, 200);
    const detailPayload = await detail.json();
    assert.equal(detailPayload.game.database_id, event.id);
    assert.equal(detailPayload.market, null);
    assert.equal(detailPayload.projection, null);

    const wrongSource = await fetch(
      `${baseUrl}/api/v2/game?season=${season.year}&game_id=${encodeURIComponent(`other:${event.sourceEventId}`)}`,
    );
    assert.equal(wrongSource.status, 404);

    const teamSchedule = await fetch(
      `${baseUrl}/api/v2/team/schedule?season=${season.year}&team=${encodeURIComponent(teamA.name)}`,
    );
    assert.equal(teamSchedule.status, 200);
    assert.equal((await teamSchedule.json()).games[0].game_id, detailPayload.game.game_id);
  });

  test("returns configured points rubric and a Calcutta-scoped consortium leaderboard", async () => {
    const rubric = await fetch(`${baseUrl}/api/v2/points-rubric?season=${season.year}`);
    assert.equal(rubric.status, 200);
    const rules = (await rubric.json()).rules;
    assert.equal(rules.find((rule) => rule.metric === "win").value, 10);
    assert.equal(rules.find((rule) => rule.metric === "marquee_pt_diff").value, 2);

    const leaderboard = await fetch(`${baseUrl}/api/v2/leaderboard/consortia?season=${season.year}`);
    assert.equal(leaderboard.status, 200);
    const rows = (await leaderboard.json()).rows;
    const consortiumRow = rows.find((row) => row.consortium === consortium.name);
    assert.ok(consortiumRow);
    assert.equal(consortiumRow.realized_return, null);
    assert.equal(consortiumRow.net_return, null);
  });

  test("uses the NFL default rubric without an override, fails closed for partial overrides, and never serializes entry sentinels", async () => {
    const { loadCalculatedTeamReturnsForCalcutta, auditStoredEntryReturnDiscrepancies } =
      await import("../lib/calcuttaReturns.ts");
    const [defaultCalcutta, partialCalcutta, cfbCalcutta] = await db
      .insert(calcuttasTable)
      .values([
        {
          seasonId: season.id, year: season.year, name: `Default rubric ${season.year}`, sport: "NFL",
          competitionFormat: "NFL_REGULAR_SEASON", isCanonical: false,
        },
        {
          seasonId: season.id, year: season.year, name: `Partial rubric ${season.year}`, sport: "NFL",
          competitionFormat: "NFL_REGULAR_SEASON", isCanonical: false,
        },
        {
          seasonId: season.id, year: season.year, name: `No CFB rubric ${season.year}`, sport: "CFB",
          competitionFormat: "CFB_REGULAR_SEASON", isCanonical: false,
        },
      ])
      .returning();
    const [defaultEntry, partialEntry, cfbEntry] = await db
      .insert(calcuttaEntriesTable)
      .values([
        // These deliberately impossible values must never become output values.
        { calcuttaId: defaultCalcutta.id, teamId: teamA.id, realizedReturn: "987654", realizedMultiple: "123", netReturn: "456", netPctReturn: "789", markToMarket: "654321" },
        { calcuttaId: partialCalcutta.id, teamId: teamA.id },
        { calcuttaId: cfbCalcutta.id, teamId: teamA.id },
      ])
      .returning();
    await db.insert(positionsTable).values([
      { entryId: defaultEntry.id, bidderId: owner.id, ownershipShare: "1", source: "primary", costBasis: "100" },
      { entryId: partialEntry.id, bidderId: owner.id, ownershipShare: "1", source: "primary", costBasis: "100" },
      { entryId: cfbEntry.id, bidderId: owner.id, ownershipShare: "1", source: "primary", costBasis: "100" },
    ]);
    const realized = {
      wins: 1, losses: 0, ties: 0, pt_diff: 7,
      ordinary_wins: 1, marquee_wins: 0, ordinary_ties: 0, marquee_ties: 0,
      ordinary_pt_diff: 7, marquee_pt_diff: 0,
      playoff_berth: 0, div_round: 0, conf_round: 0, sb_berth: 0, win_super_bowl: 0,
    };
    const mtm = {
      win: 1, tie: 0, pt_diff: 7, playoff_berth: 0,
      div_round: 0, conf_round: 0, sb_berth: 0, win_super_bowl: 0,
    };
    const [nflWeekOne] = await db
      .select()
      .from(sportPeriodsTable)
      .where(and(
        eq(sportPeriodsTable.sport, "NFL"),
        eq(sportPeriodsTable.competition, "NFL_REGULAR_SEASON"),
        eq(sportPeriodsTable.sequence, 1),
      ))
      .limit(1);
    assert.ok(nflWeekOne);
    await db.insert(snapshotMetricsTable).values([
      ...Object.entries(realized).map(([metric, value]) => ({
        calcuttaId: defaultCalcutta.id, entryId: defaultEntry.id, periodId: nflWeekOne.id,
        basis: "realized", metric, value: String(value), source: "test",
      })),
      ...Object.entries(mtm).map(([metric, value]) => ({
        calcuttaId: defaultCalcutta.id, entryId: defaultEntry.id, periodId: nflWeekOne.id,
        basis: "mtm", metric, value: String(value), source: "test",
      })),
    ]);
    await db.insert(payoutRulesTable).values({
      calcuttaId: partialCalcutta.id, metric: "win", dollarsPerUnit: "10", playoffMultiplier: "1",
    });

    const calculated = await loadCalculatedTeamReturnsForCalcutta(defaultCalcutta.id, 1);
    const values = calculated.get(teamA.id);
    assert.ok(values?.realized?.grossReturn > 0);
    assert.ok(values?.mtm?.grossReturn > 0);
    assert.equal((await loadCalculatedTeamReturnsForCalcutta(partialCalcutta.id)).size, 0);
    assert.equal((await loadCalculatedTeamReturnsForCalcutta(cfbCalcutta.id)).size, 0);

    const audit = await auditStoredEntryReturnDiscrepancies(defaultCalcutta.id);
    assert.equal(audit.ok, false);
    assert.equal(audit.issues.filter((issue) => issue.kind === "mismatch").length, 5);
    assert.deepEqual(
      audit.issues.filter((issue) => issue.kind === "mismatch").map((issue) => issue.field).sort(),
      ["markToMarket", "netPctReturn", "netReturn", "realizedMultiple", "realizedReturn"],
    );

    const legacyResponse = await fetch(
      `${baseUrl}/api/results?season=${season.year}&calcuttaId=${defaultCalcutta.id}&period=1&basis=realized`,
    );
    const legacyRow = (await legacyResponse.json()).find((row) => row.teamId === teamA.id);
    const projection = {
      realizedReturn: legacyRow.realizedReturn,
      realizedMultiple: legacyRow.realizedMultiple,
      netReturn: legacyRow.netReturn,
      netPctReturn: legacyRow.netPctReturn,
      markToMarket: legacyRow.markToMarket,
    };
    const expected = {
      realizedReturn: values.realized.grossReturn,
      realizedMultiple: values.realized.grossReturn / 100,
      netReturn: values.realized.grossReturn - 100,
      netPctReturn: (values.realized.grossReturn - 100) / 100,
      markToMarket: values.mtm.grossReturn,
    };
    assert.equal(JSON.stringify(projection), JSON.stringify(expected));
    assert.doesNotMatch(JSON.stringify(projection), /987654|654321/);

    const v2Response = await fetch(
      `${baseUrl}/api/v2/owner/portfolio?season=${season.year}&owner=${encodeURIComponent(owner.name)}&calcuttaId=${defaultCalcutta.id}&period=1`,
    );
    const v2 = await v2Response.json();
    const v2Team = v2.teams.find((row) => row.team_id === teamA.id);
    assert.equal(v2Team.realized_return, values.realized.grossReturn);
    assert.equal(v2Team.current_mtm, values.mtm.grossReturn);

    await db.delete(snapshotMetricsTable).where(and(
      eq(snapshotMetricsTable.calcuttaId, defaultCalcutta.id),
      eq(snapshotMetricsTable.entryId, defaultEntry.id),
      eq(snapshotMetricsTable.basis, "mtm"),
    ));
    const realizedOnlyAudit = await auditStoredEntryReturnDiscrepancies(defaultCalcutta.id);
    assert.equal(realizedOnlyAudit.issues.filter((issue) => issue.kind === "mismatch").length, 4);
    assert.deepEqual(
      realizedOnlyAudit.issues
        .filter((issue) => issue.kind === "partial_coverage")
        .map((issue) => issue.field),
      ["markToMarket"],
    );
  });

  test("exposes matching authenticated MCP tools", { skip: !MCP_KEY }, async () => {
    const list = await mcpRequest(baseUrl, 1, "tools/list");
    const names = new Set(list.result.tools.map((tool) => tool.name));
    for (const name of [
      "get_owner_portfolio",
      "get_owner_summary",
      "get_owner_portfolio_performance",
      "get_schedule",
      "get_team_schedule",
      "get_game",
      "get_points_rubric",
      "get_consortium_leaderboard",
    ]) assert.ok(names.has(name), name);

    const snapshotAt = new Date();
    await db.insert(eventMarketSnapshotsTable).values({
      eventId: event.id,
      snapshotAt,
      source: "test-market",
      spread: "-3.50",
      homeMoneyline: -175,
      awayMoneyline: 150,
      homeImpliedProbability: "0.600000",
      awayImpliedProbability: "0.400000",
      total: "44.50",
    });
    await db.insert(eventProjectionsTable).values({
      eventId: event.id,
      snapshotAt,
      modelName: "test-model",
      source: "test-projection",
      homeWinProbability: "0.625000",
      awayWinProbability: "0.375000",
      projectedHomeScore: "24.00",
      projectedAwayScore: "20.00",
      projectedPointDifferential: "4.00",
    });
    const restTeamSchedule = await fetch(
      `${baseUrl}/api/v2/team/schedule?season=${season.year}&team=${encodeURIComponent(teamA.name)}&include_market=true&include_projection=true`,
    );
    assert.equal(restTeamSchedule.status, 200);
    const restPayload = await restTeamSchedule.json();
    assert.equal(restPayload.games[0].market.spread, -3.5);
    assert.equal(restPayload.games[0].projection.model_name, "test-model");
    const mcpTeamSchedule = await mcpRequest(baseUrl, 2, "tools/call", {
      name: "get_team_schedule",
      arguments: {
        season: season.year,
        team: teamA.name,
        includeMarket: true,
        includeProjection: true,
      },
    });
    const mcpSchedulePayload = JSON.parse(mcpText(mcpTeamSchedule));
    assert.deepEqual(mcpSchedulePayload.games[0].market, restPayload.games[0].market);
    assert.deepEqual(mcpSchedulePayload.games[0].projection, restPayload.games[0].projection);

    const call = await mcpRequest(baseUrl, 3, "tools/call", {
      name: "get_game",
      arguments: { season: season.year, gameId: `espn:${event.sourceEventId}` },
    });
    const payload = JSON.parse(mcpText(call));
    assert.equal(payload.game.game_id, `espn:${event.sourceEventId}`);
  });
});