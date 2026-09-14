import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq, ilike, inArray } from "drizzle-orm";

const DATABASE_URL = process.env.MCP_VALUATION_TEST_DATABASE_URL;
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
let validateAndPromoteCurrentMtm;

if (canRun) {
  process.env.DATABASE_URL = DATABASE_URL;
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
  ({ validateAndPromoteCurrentMtm } = await import("../lib/currentMtm.ts"));
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
  let liveEntry;
  let liveSnapshot;
  let sourceUrl;
  const methodVersion = "mcp-contract-test-v1";
  const asOf = new Date("2099-08-01T15:00:00.000Z");

  before(async () => {
    await runDatabaseMigrations();
    const fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const baseYear = 7000 + (Date.now() % 1000) + Math.floor(Math.random() * 900000);
    years = [baseYear, baseYear + 1];
    const seasons = await db.insert(seasonsTable).values(years.map((year) => ({
      year,
      label: `MCP valuation contract ${fixtureId} ${year}`,
      isActive: false,
      isComplete: false,
    }))).returning();
    seasonIds = seasons.map((season) => season.id);

    const allTeams = await db.select({ id: teamsTable.id, name: teamsTable.name })
      .from(teamsTable);
    [team] = allTeams.filter((row) => /Buffalo/i.test(row.name));
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
    const liveEntries = await db.insert(calcuttaEntriesTable).values(
      allTeams.map((row) => ({
        calcuttaId: livePool.id,
        teamId: row.id,
        realizedReturn: row.id === team.id ? "999.00" : "0.00",
        markToMarket: row.id === team.id ? "777.00" : "0.00",
      })),
    ).returning();
    const missingEntries = await db.insert(calcuttaEntriesTable).values(
      allTeams.map((row) => ({
        calcuttaId: missingPool.id,
        teamId: row.id,
        realizedReturn: row.id === team.id ? "999.00" : "0.00",
        markToMarket: row.id === team.id ? "777.00" : "0.00",
      })),
    ).returning();
    liveEntry = liveEntries.find((row) => row.teamId === team.id);
    const missingEntry = missingEntries.find((row) => row.teamId === team.id);
    assert.ok(liveEntry && missingEntry);
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
      diagnostics: {
        fixture: true,
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
         pot: 8000,
        rubric: { win: 10, super_bowl_win: 800 },
         entries: allTeams.map((row) => ({
           team: row.id === team.id ? "BUF" : `TEAM-${row.id}`,
           price: 250,
           entry_id: String(liveEntries.find((entry) => entry.teamId === row.id).id),
         })),
        remaining_schedule: [{ week: 1 }],
      },
      inputProvenance: {
        schema_version: "1.0",
        schedule: [],
        realized_results: [],
        standings: [],
      },
    }).returning();
    await db.insert(mtmEntryValuationTable).values(
      liveEntries.map((entry) => ({
        snapshotId: liveSnapshot.id,
        entryId: entry.id,
        expectedPoints: "42.00",
        expectedShare: "1.000000",
        expectedPayout: "250.00",
        auctionPrice: entry.id === liveEntry.id ? "100.00" : "250.00",
        mtmMultiple: "1.000",
      })),
    );
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
    await validateAndPromoteCurrentMtm({
      poolId: livePool.id,
      sourceSnapshotId: liveSnapshot.id,
      markType: "official",
    });

    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
    // This contract test is restricted to a dedicated disposable database
    // because promoted MTM publication records are intentionally append-only.
    if (bidder) await db.delete(biddersTable).where(eq(biddersTable.id, bidder.id));
  });

  test("defines unqualified MTM as net and keeps realized payout separate", async () => {
    const glossary = JSON.parse(await mcpCall(baseUrl, 1, "get_calcutta_glossary"));
    assert.equal(glossary.interpretation_rules.unqualified_mtm, "net_mtm");
    assert.equal(glossary.interpretation_rules.never_substitute_realized_for_mtm, true);
    assert.match(glossary.terms.net_mtm, /Gross MTM minus signed cost basis/);
    assert.match(glossary.terms.realized_payout, /not MTM/);
  });

  test("applies the universal latest-update response preset", async () => {
    const contract = JSON.parse(await mcpCall(baseUrl, 31, "get_latest_update_response_contract"));
    assert.ok(contract.trigger_phrases.includes("Give me my update."));
    assert.equal(contract.economics.unqualified_mtm, "net_mtm");
    assert.equal(contract.economics.no_realized_substitution, true);
    assert.equal(contract.format.body, "One top-level bullet per team; no table.");

    const update = await mcpCall(baseUrl, 32, "get_latest_portfolio_update", {
      owner: bidder.name,
      season: years[0],
      calcuttaId: livePool.id,
    });
    assert.match(update, /^Last refresh: \*\*August 1, 2099 at 11:00 AM ET\*\*/);
    assert.match(update, /- \*\*Buffalo Bills \(100%\)\*\*/);
    assert.match(update, /\*\*\$250 MTM\*\* \(\*\*\+\$150 net\*\*\)/);
    assert.match(update, /change unavailable \(no prior comparable refresh\)/);
    assert.match(update, /No material supported development since the prior refresh/);
    assert.doesNotMatch(update, /\|/);
    assert.doesNotMatch(update, /999|777/);
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
    const ownerPlayoffOdds = JSON.parse(await mcpCall(baseUrl, 30, "get_owner_playoff_odds", {
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
    assert.equal(teamValuation.gross_mtm, 250);
    assert.equal(teamValuation.cost_basis, 100);
    assert.equal(teamValuation.net_mtm, 150);
    assert.equal(teamValuation.snapshot_id, liveSnapshot.id);
    assert.equal(teamValuation.method_version, methodVersion);
    assert.equal(teamValuation.mark.versionId > 0, true);
    assert.equal(teamValuation.mark.sourceSnapshotId, liveSnapshot.id);
    assert.equal(teamValuation.mark.type, "official");
    assert.equal(teamValuation.mark.status, "current");
    assert.equal(teamValuation.week, "Week 0");
    assert.equal(ownerValuation.available, true);
    assert.equal(ownerValuation.gross_mtm, 250);
    assert.equal(ownerValuation.signed_cost_basis, 100);
    assert.equal(ownerValuation.net_mtm, 150);
    assert.equal(ownerValuation.mark.sourceSnapshotId, liveSnapshot.id);
    assert.equal(ownerValuation.mark.type, "official");
    assert.equal(ownerValuation.holdings[0].team_code, "BUF");
    assert.equal(ownerValuation.holdings[0].projection_available, true);
    assert.equal(ownerValuation.holdings[0].playoff_odds.playoff_berth, 0.72);
    assert.equal(ownerValuation.holdings[0].playoff_odds.super_bowl_win, 0.0625);
    assert.deepEqual(ownerPlayoffOdds, ownerValuation);
    assert.equal(legacyTeam, teamValuation.net_mtm);
    assert.equal(legacyOwner, ownerValuation.net_mtm);
    assert.notEqual(teamValuation.net_mtm, 999, "realized return must not be substituted");
    assert.notEqual(teamValuation.net_mtm, 777, "legacy manual MTM must not be substituted");
  });

  test("all current-value consumers stay on the promoted source after newer raw attempts", async () => {
    const [failedSource] = await db.insert(mtmSnapshotTable).values({
      poolId: livePool.id,
      asOf: new Date("2099-08-02T15:00:00.000Z"),
      asOfHour: new Date("2099-08-02T15:00:00.000Z"),
      trigger: "scheduled",
      status: "failed",
      methodVersion: "newer-failed-fixture",
      error: "fixture failure",
    }).returning();
    const [incompleteSource] = await db.insert(mtmSnapshotTable).values({
      poolId: livePool.id,
      asOf: new Date("2099-08-03T15:00:00.000Z"),
      asOfHour: new Date("2099-08-03T15:00:00.000Z"),
      trigger: "scheduled",
      status: "ok",
      methodVersion: "newer-incomplete-fixture",
      stateJson: { entries: [{ team: "BUF", entry_id: String(liveEntry.id) }] },
    }).returning();
    await db.insert(mtmEntryValuationTable).values({
      snapshotId: incompleteSource.id,
      entryId: liveEntry.id,
      expectedPoints: "9999.00",
      expectedPayout: "9999.00",
      auctionPrice: "1.00",
      mtmMultiple: "9999.000",
    });
    await db.insert(mtmTeamProjectionTable).values({
      snapshotId: incompleteSource.id,
      team: "BUF",
      eWinsTotal: "0.00",
      eRemainingWins: "0.00",
      pBerth: "0.0100",
      pDivisional: "0.0200",
      pConf: "0.0300",
      pSbBerth: "0.0400",
      pSbWin: "0.0500",
    });
    assert.ok(failedSource.id < incompleteSource.id);

    const valuationResponse = await fetch(
      `${baseUrl}/api/mtm/valuation?season=${years[0]}&calcuttaId=${livePool.id}`,
    );
    assert.equal(valuationResponse.status, 200);
    const valuation = await valuationResponse.json();
    assert.equal(valuation.versionId > 0, true);
    assert.equal(valuation.sourceSnapshotId, liveSnapshot.id);
    assert.equal(valuation.mark.sourceSnapshotId, liveSnapshot.id);
    assert.equal(valuation.mark.type, "official");
    assert.equal(valuation.mark.model.name, methodVersion);
    const valuationTeam = valuation.teams.find((row) => row.teamId === team.id);
    const valuationOwner = valuation.owners.find((row) => row.bidderId === bidder.id);
    assert.equal(valuationTeam.grossExpectedPayout, 250);
    assert.equal(valuationTeam.net, 150);
    assert.equal(valuationOwner.grossExpectedPayout, 250);
    assert.equal(valuationOwner.net, 150);

    const [teamValuation, ownerValuation, resultTeams, resultOwners] = await Promise.all([
      mcpCall(baseUrl, 41, "get_current_team_valuation", {
        team: team.name, season: years[0], calcuttaId: livePool.id,
      }).then(JSON.parse),
      mcpCall(baseUrl, 42, "get_current_owner_valuation", {
        owner: bidder.name, season: years[0], calcuttaId: livePool.id,
      }).then(JSON.parse),
      fetch(`${baseUrl}/api/results?season=${years[0]}&calcuttaId=${livePool.id}&basis=mtm`)
        .then((response) => response.json()),
      fetch(`${baseUrl}/api/results/by-owner?season=${years[0]}&calcuttaId=${livePool.id}&basis=mtm`)
        .then((response) => response.json()),
    ]);
    assert.equal(teamValuation.snapshot_id, liveSnapshot.id);
    assert.equal(teamValuation.mark.sourceSnapshotId, liveSnapshot.id);
    assert.equal(teamValuation.method_version, methodVersion);
    assert.equal(teamValuation.gross_mtm, 250);
    assert.equal(teamValuation.net_mtm, 150);
    assert.equal(teamValuation.playoff_odds.playoff_berth, 0.72);
    assert.equal(teamValuation.playoff_odds.super_bowl_win, 0.0625);
    assert.equal(ownerValuation.snapshot_id, liveSnapshot.id);
    assert.equal(ownerValuation.mark.sourceSnapshotId, liveSnapshot.id);
    assert.equal(ownerValuation.method_version, methodVersion);
    assert.equal(ownerValuation.gross_mtm, 250);
    assert.equal(ownerValuation.signed_cost_basis, 100);
    assert.equal(ownerValuation.net_mtm, 150);
    assert.equal(ownerValuation.holdings[0].gross_mtm_share, 250);
    assert.equal(ownerValuation.holdings[0].net_mtm, 150);
    assert.equal(ownerValuation.holdings[0].playoff_odds.playoff_berth, 0.72);
    assert.equal(ownerValuation.holdings[0].playoff_odds.super_bowl_win, 0.0625);
    assert.notEqual(teamValuation.snapshot_id, failedSource.id);
    assert.notEqual(teamValuation.snapshot_id, incompleteSource.id);
    assert.notEqual(ownerValuation.snapshot_id, failedSource.id);
    assert.notEqual(ownerValuation.snapshot_id, incompleteSource.id);
    assert.notEqual(teamValuation.method_version, "newer-failed-fixture");
    assert.notEqual(teamValuation.method_version, "newer-incomplete-fixture");
    assert.notEqual(ownerValuation.method_version, "newer-failed-fixture");
    assert.notEqual(ownerValuation.method_version, "newer-incomplete-fixture");
    assert.notEqual(teamValuation.gross_mtm, 9999);
    assert.notEqual(ownerValuation.gross_mtm, 9999);
    assert.notEqual(teamValuation.playoff_odds.playoff_berth, 0.01);
    assert.notEqual(ownerValuation.holdings[0].playoff_odds.playoff_berth, 0.01);
    const resultTeam = resultTeams.find((row) => row.teamName === team.name);
    const resultOwner = resultOwners.find((row) => row.bidderName === bidder.name);
    assert.equal(resultTeam.markToMarket, 250);
    assert.equal(resultTeam.netMtm, 150);
    assert.equal(resultTeam.currentMtmVersion.markType, "official");
    assert.equal(resultTeam.currentMtmVersion.sourceSnapshotId, liveSnapshot.id);
    assert.equal(resultTeam.currentMtmVersion.versionId, valuation.versionId);
    assert.equal(resultOwner.totalMtm, 250);
    assert.equal(resultOwner.totalNetMtm, 150);
    assert.equal(resultOwner.currentMtmVersion.markType, "official");
    assert.equal(resultOwner.currentMtmVersion.sourceSnapshotId, liveSnapshot.id);
    assert.equal(resultOwner.currentMtmVersion.versionId, valuation.versionId);
    assert.equal(Number(await mcpCall(baseUrl, 43, "get_team_mtm", {
      team: team.name, season: years[0], calcuttaId: livePool.id,
    })), 150);
    assert.equal(Number(await mcpCall(baseUrl, 44, "get_owner_mtm", {
      owner: bidder.name, season: years[0], calcuttaId: livePool.id,
    })), 150);
    await db.delete(mtmSnapshotTable).where(inArray(mtmSnapshotTable.id, [
      failedSource.id,
      incompleteSource.id,
    ]));
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
     assert.match(teamValuation.reason, /No current coherent MTM version/);
    assert.equal(ownerValuation.available, false);
    assert.equal(ownerValuation.default_measure, "net_mtm");
     assert.match(ownerValuation.reason, /No current coherent MTM version/);
    assert.equal(evidence.available, false);
    assert.match(evidence.reason, /No successful Live Tracker pipeline snapshot/);
    assert.equal(legacyTeam, "null");
    assert.equal(legacyOwner, "null");
  });
});