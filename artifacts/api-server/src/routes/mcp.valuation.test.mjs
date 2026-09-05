import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq, ilike, inArray } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const MCP_KEY = process.env.MCP_API_KEY;
const canRun = Boolean(DATABASE_URL && MCP_KEY);

let app;
let db;
let runDatabaseMigrations;
let seasonsTable;
let teamsTable;
let biddersTable;
let calcuttasTable;
let calcuttaEntriesTable;
let teamSeasonAuctionsTable;
let positionsTable;
let mtmSnapshotTable;
let mtmEntryValuationTable;
let mtmTeamProjectionTable;
let mtmMarketQuoteTable;

if (canRun) {
  ({
    db,
    runDatabaseMigrations,
    seasonsTable,
    teamsTable,
    biddersTable,
    calcuttasTable,
    calcuttaEntriesTable,
    teamSeasonAuctionsTable,
    positionsTable,
    mtmSnapshotTable,
    mtmEntryValuationTable,
    mtmTeamProjectionTable,
    mtmMarketQuoteTable,
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

async function mcpCall(baseUrl, id, name, args = {}) {
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${MCP_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const json = body.trim().startsWith("event:")
    ? body.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length)
    : body;
  assert.ok(json, body);
  const envelope = JSON.parse(json);
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.notEqual(text, undefined, json);
  return text;
}

describe("MCP Live Tracker valuation contract", { skip: !canRun }, () => {
  let server;
  let baseUrl;
  let seasonIds;
  let years;
  let bidder;
  let team;
  let livePool;
  let missingPool;
  let liveSnapshot;
  let sourceUrl;
  const methodVersion = "mcp-contract-test-v1";
  const asOf = new Date("2099-08-01T15:00:00.000Z");

  before(async () => {
    await runDatabaseMigrations();
    const fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const baseYear = 7000 + (Date.now() % 1000);
    years = [baseYear, baseYear + 1];
    const seasons = await db.insert(seasonsTable).values(years.map((year) => ({
      year,
      label: `MCP valuation contract ${fixtureId} ${year}`,
      isActive: false,
      isComplete: false,
    }))).returning();
    seasonIds = seasons.map((season) => season.id);

    [team] = await db.select({ id: teamsTable.id, name: teamsTable.name })
      .from(teamsTable)
      .where(ilike(teamsTable.name, "%Buffalo%"))
      .limit(1);
    assert.ok(team, "the Buffalo NFL team must be seeded");

    [bidder] = await db.insert(biddersTable)
      .values({ name: `MCP valuation owner ${fixtureId}` })
      .returning();

    [livePool, missingPool] = await db.insert(calcuttasTable).values([
      {
        seasonId: seasonIds[0],
        year: years[0],
        name: `MCP live valuation pool ${fixtureId}`,
        sport: "NFL",
        isCanonical: true,
      },
      {
        seasonId: seasonIds[1],
        year: years[1],
        name: `MCP missing valuation pool ${fixtureId}`,
        sport: "NFL",
        isCanonical: true,
      },
    ]).returning();

    await db.insert(teamSeasonAuctionsTable).values([
      { seasonId: seasonIds[0], teamId: team.id, bidAmount: "100.00" },
      { seasonId: seasonIds[1], teamId: team.id, bidAmount: "100.00" },
    ]);
    const [liveEntry, missingEntry] = await db.insert(calcuttaEntriesTable).values([
      {
        calcuttaId: livePool.id,
        teamId: team.id,
        realizedReturn: "999.00",
        markToMarket: "777.00",
      },
      {
        calcuttaId: missingPool.id,
        teamId: team.id,
        realizedReturn: "999.00",
        markToMarket: "777.00",
      },
    ]).returning();
    await db.insert(positionsTable).values([
      {
        entryId: liveEntry.id,
        bidderId: bidder.id,
        ownershipShare: "1.000000",
        source: "primary",
        costBasis: "100.00",
      },
      {
        entryId: missingEntry.id,
        bidderId: bidder.id,
        ownershipShare: "1.000000",
        source: "primary",
        costBasis: "100.00",
      },
    ]);

    [liveSnapshot] = await db.insert(mtmSnapshotTable).values({
      poolId: livePool.id,
      asOf,
      asOfHour: asOf,
      createdAt: asOf,
      trigger: "scheduled",
      status: "ok",
      methodVersion,
      diagnostics: { fixture: true },
      stateJson: {
        pot: 100,
        rubric: { win: 10, super_bowl_win: 800 },
        entries: [{ team: "BUF", price: 100, entry_id: String(liveEntry.id) }],
        remaining_schedule: [{ week: 1 }],
      },
      inputProvenance: {
        schema_version: "1.0",
        schedule: [],
        realized_results: [],
        standings: [],
      },
    }).returning();
    await db.insert(mtmEntryValuationTable).values({
      snapshotId: liveSnapshot.id,
      entryId: liveEntry.id,
      expectedPoints: "42.00",
      expectedShare: "1.000000",
      expectedPayout: "250.00",
      auctionPrice: "100.00",
      mtmMultiple: "2.500",
    });
    await db.insert(mtmTeamProjectionTable).values({
      snapshotId: liveSnapshot.id,
      team: "BUF",
      eWinsTotal: "11.250",
      eRemainingWins: "11.250",
      pBerth: "0.7200",
      pDivisional: "0.4800",
      pConf: "0.2100",
      pSbBerth: "0.1250",
      pSbWin: "0.0625",
      rating: "1.500",
    });
    sourceUrl = "https://api.example.test/markets/KXNFLWINS-99BUF-11";
    await db.insert(mtmMarketQuoteTable).values({
      snapshotId: liveSnapshot.id,
      source: "kalshi",
      sourceUrl,
      series: "KXNFLWINS",
      marketTicker: "KXNFLWINS-99BUF-11",
      team: "BUF",
      strike: "11.00",
      yesBid: "0.4200",
      yesAsk: "0.4600",
      volume: 123,
      fetchedAt: new Date("2099-08-01T14:59:00.000Z"),
      rawQuote: { must_not_leak: "secret fixture payload" },
    });

    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
    if (seasonIds?.length) {
      await db.delete(seasonsTable).where(inArray(seasonsTable.id, seasonIds));
    }
    if (bidder) await db.delete(biddersTable).where(eq(biddersTable.id, bidder.id));
  });

  test("defines unqualified MTM as net and keeps realized payout separate", async () => {
    const glossary = JSON.parse(await mcpCall(baseUrl, 1, "get_calcutta_glossary"));
    assert.equal(glossary.interpretation_rules.unqualified_mtm, "net_mtm");
    assert.equal(glossary.interpretation_rules.never_substitute_realized_for_mtm, true);
    assert.match(glossary.terms.net_mtm, /Gross MTM minus signed cost basis/);
    assert.match(glossary.terms.realized_payout, /not MTM/);
  });

  test("structured and legacy team and owner tools share the Live Tracker net mark", async () => {
    const args = { season: years[0], calcuttaId: livePool.id };
    const teamValuation = JSON.parse(await mcpCall(baseUrl, 2, "get_current_team_valuation", {
      ...args,
      team: team.name,
    }));
    const ownerValuation = JSON.parse(await mcpCall(baseUrl, 3, "get_current_owner_valuation", {
      ...args,
      owner: bidder.name,
    }));
    const legacyTeam = Number(await mcpCall(baseUrl, 4, "get_team_mtm", {
      ...args,
      team: team.name,
    }));
    const legacyOwner = Number(await mcpCall(baseUrl, 5, "get_owner_mtm", {
      ...args,
      owner: bidder.name,
    }));

    assert.equal(teamValuation.available, true);
    assert.equal(teamValuation.default_measure, "net_mtm");
    assert.equal(teamValuation.gross_mtm, 100);
    assert.equal(teamValuation.cost_basis, 100);
    assert.equal(teamValuation.net_mtm, 0);
    assert.equal(teamValuation.snapshot_id, liveSnapshot.id);
    assert.equal(teamValuation.method_version, methodVersion);
    assert.equal(ownerValuation.available, true);
    assert.equal(ownerValuation.gross_mtm, 100);
    assert.equal(ownerValuation.signed_cost_basis, 100);
    assert.equal(ownerValuation.net_mtm, 0);
    assert.equal(legacyTeam, teamValuation.net_mtm);
    assert.equal(legacyOwner, ownerValuation.net_mtm);
    assert.notEqual(teamValuation.net_mtm, 999, "realized return must not be substituted");
    assert.notEqual(teamValuation.net_mtm, 777, "legacy manual MTM must not be substituted");
  });

  test("returns auditable normalized evidence without leaking raw provider payloads", async () => {
    const evidenceText = await mcpCall(baseUrl, 6, "get_mtm_snapshot_evidence", {
      season: years[0],
      calcuttaId: livePool.id,
      team: team.name,
      quoteLimit: 10,
    });
    const evidence = JSON.parse(evidenceText);
    assert.equal(evidence.available, true);
    assert.equal(evidence.interpretation.unqualified_mtm, "net_mtm");
    assert.equal(evidence.snapshot.id, liveSnapshot.id);
    assert.equal(evidence.snapshot.method_version, methodVersion);
    assert.equal(evidence.snapshot.as_of, asOf.toISOString());
    assert.equal(evidence.projections[0].super_bowl_berth_probability, 0.125);
    assert.equal(evidence.projections[0].super_bowl_win_probability, 0.0625);
    assert.equal(evidence.market_inputs[0].provider, "kalshi");
    assert.equal(evidence.market_inputs[0].source_url, sourceUrl);
    assert.equal(evidence.market_inputs[0].ticker, "KXNFLWINS-99BUF-11");
    assert.equal(evidence.market_inputs[0].fetched_at, "2099-08-01T14:59:00.000Z");
    assert.equal(evidence.market_inputs[0].provenance_status, "available");
    assert.doesNotMatch(evidenceText, /must_not_leak|secret fixture payload/);
  });

  test("reports unavailable pipeline MTM instead of falling back to realized or manual values", async () => {
    const args = { season: years[1], calcuttaId: missingPool.id };
    const teamValuation = JSON.parse(await mcpCall(baseUrl, 7, "get_current_team_valuation", {
      ...args,
      team: team.name,
    }));
    const ownerValuation = JSON.parse(await mcpCall(baseUrl, 8, "get_current_owner_valuation", {
      ...args,
      owner: bidder.name,
    }));
    const evidence = JSON.parse(await mcpCall(baseUrl, 9, "get_mtm_snapshot_evidence", args));
    const legacyTeam = await mcpCall(baseUrl, 10, "get_team_mtm", {
      ...args,
      team: team.name,
    });
    const legacyOwner = await mcpCall(baseUrl, 11, "get_owner_mtm", {
      ...args,
      owner: bidder.name,
    });

    assert.equal(teamValuation.available, false);
    assert.equal(teamValuation.default_measure, "net_mtm");
    assert.match(teamValuation.reason, /No complete Live Tracker pipeline mark/);
    assert.equal(ownerValuation.available, false);
    assert.equal(ownerValuation.default_measure, "net_mtm");
    assert.match(ownerValuation.reason, /No complete Live Tracker pipeline mark/);
    assert.equal(evidence.available, false);
    assert.match(evidence.reason, /No successful Live Tracker pipeline snapshot/);
    assert.equal(legacyTeam, "null");
    assert.equal(legacyOwner, "null");
  });
});