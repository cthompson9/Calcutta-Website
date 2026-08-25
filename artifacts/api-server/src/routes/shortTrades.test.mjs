/**
 * Integration coverage for signed trade positions.
 *
 * Uses an isolated randomly-named season and removes every created row when
 * finished. Requires DATABASE_URL and ADMIN_API_KEY; skipped outside a database
 * test environment.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq, inArray, ne } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const MCP_KEY = process.env.MCP_API_KEY;
const canRun = Boolean(DATABASE_URL && ADMIN_KEY);

let db;
let biddersTable;
let seasonsTable;
let teamsTable;
let teamBiddersTable;
let teamSeasonAuctionsTable;
let tradesTable;
let positionsTable;
let app;
let loadSeasonOwnership;
let resolveOrCreateBidder;

if (canRun) {
  ({
    db,
    biddersTable,
    seasonsTable,
    teamsTable,
    teamBiddersTable,
    teamSeasonAuctionsTable,
    tradesTable,
    positionsTable,
  } = await import("@workspace/db"));
  ({ default: app } = await import("../app.ts"));
  ({ loadSeasonOwnership } = await import("../lib/seasonOwnership.ts"));
  ({ resolveOrCreateBidder } = await import("../mcpServer.ts"));
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
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("short trades and new trade participants", { skip: !canRun }, () => {
  let seasonYear;
  let seasonId;
  let teamId;
  let primaryOwner;
  let primaryBuyer;
  let shortSeller;
  let newBuyer;
  let server;
  let baseUrl;
  const createdBidderIds = [];

  before(async () => {
    seasonYear = 1_000_000_000 + Math.floor(Math.random() * 100_000_000);
    const [season] = await db
      .insert(seasonsTable)
      .values({
        year: seasonYear,
        isActive: false,
        isComplete: false,
        label: "Short-trade integration fixture — safe to delete",
      })
      .returning();
    seasonId = season.id;

    const [team] = await db.select({ id: teamsTable.id }).from(teamsTable).limit(1);
    assert.ok(team, "an NFL team fixture must exist");
    teamId = team.id;
    await db.insert(teamSeasonAuctionsTable).values({
      seasonId,
      teamId,
      bidAmount: "1000.00",
    });

    const [createdPrimaryOwner] = await db
      .insert(biddersTable)
      .values({ name: `Primary Owner ${seasonYear}` })
      .returning();
    primaryOwner = createdPrimaryOwner;
    createdBidderIds.push(primaryOwner.id);

    const [createdPrimaryBuyer] = await db
      .insert(biddersTable)
      .values({ name: `Primary Buyer ${seasonYear}` })
      .returning();
    primaryBuyer = createdPrimaryBuyer;
    createdBidderIds.push(primaryBuyer.id);

    await db.insert(teamBiddersTable).values([
      {
        seasonId,
        teamId,
        bidderId: primaryOwner.id,
        ownershipShare: "0.5000",
      },
      {
        seasonId,
        teamId,
        bidderId: primaryBuyer.id,
        ownershipShare: "0.5000",
      },
    ]);

    const [seller] = await db
      .insert(biddersTable)
      .values({ name: `Short Seller ${seasonYear}` })
      .returning();
    shortSeller = seller;
    createdBidderIds.push(seller.id);

    const firstResolution = await resolveOrCreateBidder(`New Buyer ${seasonYear}`);
    assert.equal("error" in firstResolution, false);
    assert.equal(firstResolution.created, true, "an unknown MCP owner name is registered");
    newBuyer = firstResolution.bidder;
    createdBidderIds.push(newBuyer.id);

    const secondResolution = await resolveOrCreateBidder(`  new buyer ${seasonYear}  `);
    assert.equal("error" in secondResolution, false);
    assert.equal(secondResolution.created, false, "the normalized name resolves idempotently");
    assert.equal(secondResolution.bidder.id, newBuyer.id);

    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await stopServer(server);
    if (seasonId) await db.delete(seasonsTable).where(eq(seasonsTable.id, seasonId));
    if (createdBidderIds.length > 0) {
      await db.delete(biddersTable).where(inArray(biddersTable.id, createdBidderIds));
    }
  });

  async function createAndApproveTrade({
    fromBidderId,
    toBidderId,
    percentage,
    price,
    tradeTeamId = teamId,
  }) {
    const createResponse = await fetch(`${baseUrl}/api/trades`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        seasonYear,
        teamId: tradeTeamId,
        fromBidderId,
        toBidderId,
        percentage,
        price,
        tradeDate: "2030-01-01",
      }),
    });
    const createdTrade = await createResponse.json();
    assert.equal(createResponse.status, 201, JSON.stringify(createdTrade));
    assert.equal(createdTrade.status, "pending");
    assert.equal(createdTrade.decisionAt, null);
    assert.equal(createdTrade.decisionSource, null);
    assert.equal(createdTrade.voidedAt, null);
    assert.equal(createdTrade.voidedSource, null);
    assert.equal(createdTrade.voidReason, null);

    const approvalResponse = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ status: "approved", confirmed: true }),
    });
    const approvalText = await approvalResponse.text();
    assert.equal(approvalResponse.status, 200, approvalText);
    const approvedTrade = JSON.parse(approvalText);
    assert.equal(approvedTrade.status, "approved");
    assert.equal(approvedTrade.decisionSource, "commissioner_api");
    assert.ok(
      Number.isFinite(Date.parse(approvedTrade.decisionAt)),
      "a newly recorded decision has an audit timestamp",
    );
    assert.equal(approvedTrade.voidedAt, null);
    assert.equal(approvedTrade.voidedSource, null);
    assert.equal(approvedTrade.voidReason, null);
    return { createdTrade, approvedTrade };
  }

  async function callMcpTool(name, args) {
    const response = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MCP_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${name}-${Math.random()}`,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const dataLine = responseText
      .split("\n")
      .find((line) => line.startsWith("data: "));
    assert.ok(dataLine, `MCP response did not include an SSE data event: ${responseText}`);
    return JSON.parse(dataLine.slice("data: ".length));
  }

  function teamEffectiveTotal(ownership, selectedTeamId) {
    let total = 0;
    for (const teamMap of ownership.byBidder.values()) {
      total += teamMap.get(selectedTeamId)?.effectiveShare ?? 0;
    }
    return Math.round(total * 10_000) / 10_000;
  }

  test("MCP primary ownership corrections rebuild normalized primary positions", { skip: !MCP_KEY }, async () => {
    const result = await callMcpTool("set_team_primary_ownership", {
      team: (await db.select({ name: teamsTable.name }).from(teamsTable).where(eq(teamsTable.id, teamId)))[0].name,
      owners: [
        { owner: primaryOwner.name, share: 0.5 },
        { owner: primaryBuyer.name, share: 0.5 },
      ],
      season: seasonYear,
      adminKey: ADMIN_KEY,
    });
    assert.match(JSON.stringify(result), /Primary ownership corrected/i);
    const primaryPositions = await db
      .select({
        bidderId: positionsTable.bidderId,
        share: positionsTable.ownershipShare,
        source: positionsTable.source,
      })
      .from(positionsTable)
      .where(eq(positionsTable.source, "primary"));
    const fixturePositions = primaryPositions.filter(
      (position) =>
        position.bidderId === primaryOwner.id || position.bidderId === primaryBuyer.id,
    );
    assert.deepEqual(
      fixturePositions
        .map((position) => [position.bidderId, Number(position.share)])
        .sort((left, right) => left[0] - right[0]),
      [
        [primaryOwner.id, 0.5],
        [primaryBuyer.id, 0.5],
      ].sort((left, right) => left[0] - right[0]),
    );
  });

  test("allows an unauthenticated synthetic trade submission but keeps it pending", async () => {
    const response = await fetch(`${baseUrl}/api/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seasonYear,
        teamId,
        fromBidderId: shortSeller.id,
        toBidderId: newBuyer.id,
        percentage: 100,
        price: 100,
        tradeDate: "2030-01-01",
        notes: "Synthetic purchase submitted for review",
      }),
    });
    const createdTrade = await response.json();
    assert.equal(response.status, 201, JSON.stringify(createdTrade));
    assert.equal(createdTrade.status, "pending");
    assert.equal(createdTrade.decisionAt, null);
    assert.equal(createdTrade.decisionSource, null);

    const ownershipBeforeApproval = await loadSeasonOwnership(seasonId);
    assert.equal(
      ownershipBeforeApproval.byBidder.has(shortSeller.id),
      false,
      "a pending synthetic sale does not create an ownership position",
    );
    assert.equal(
      ownershipBeforeApproval.byBidder.has(newBuyer.id),
      false,
      "a pending synthetic purchase does not create an ownership position",
    );

    const missingConfirmation = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ status: "approved" }),
    });
    assert.equal(missingConfirmation.status, 400, "a decision must be explicitly confirmed");

    const unauthorizedApproval = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", confirmed: true }),
    });
    assert.equal(unauthorizedApproval.status, 401);

    const unauthorizedDelete = await fetch(`${baseUrl}/api/trades/${createdTrade.id}`, {
      method: "DELETE",
    });
    assert.equal(unauthorizedDelete.status, 401);

    const pendingVoid = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        status: "voided",
        confirmed: true,
        reason: "Attempting to void an undecided trade",
      }),
    });
    assert.equal(pendingVoid.status, 400, "only approved trades can be voided");

    const adminValidation = await fetch(`${baseUrl}/api/admin/validate`, {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    assert.equal(adminValidation.status, 204);

    const invalidAdminValidation = await fetch(`${baseUrl}/api/admin/validate`, {
      headers: { Authorization: "Bearer invalid" },
    });
    assert.equal(invalidAdminValidation.status, 401);

    const deletedPendingTrade = await fetch(`${baseUrl}/api/trades/${createdTrade.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    assert.equal(deletedPendingTrade.status, 204);
  });

  test("allows an approved trade to be corrected to rejected, then rejects later changes", async () => {
    const [auditTeam] = await db
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(ne(teamsTable.id, teamId))
      .limit(1);
    assert.ok(auditTeam, "a second NFL team fixture must exist");
    assert.notEqual(auditTeam.id, teamId);
    await db.insert(teamSeasonAuctionsTable).values({
      seasonId,
      teamId: auditTeam.id,
      bidAmount: "1000.00",
    });
    await db.insert(teamBiddersTable).values({
      seasonId,
      teamId: auditTeam.id,
      bidderId: primaryOwner.id,
      ownershipShare: "1.0000",
    });
    const [auditSeller] = await db
      .insert(biddersTable)
      .values({ name: `Audit Seller ${seasonYear}` })
      .returning();
    const [auditBuyer] = await db
      .insert(biddersTable)
      .values({ name: `Audit Buyer ${seasonYear}` })
      .returning();
    createdBidderIds.push(auditSeller.id, auditBuyer.id);

    const { createdTrade, approvedTrade } = await createAndApproveTrade({
      fromBidderId: auditSeller.id,
      toBidderId: auditBuyer.id,
      percentage: 10,
      price: 10,
      tradeTeamId: auditTeam.id,
    });

    assert.equal(approvedTrade.id, createdTrade.id);
    const rejectionResponse = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ status: "rejected", confirmed: true }),
    });
    const rejectedTrade = await rejectionResponse.json();
    assert.equal(rejectionResponse.status, 200, JSON.stringify(rejectedTrade));
    assert.equal(rejectedTrade.status, "rejected");
    assert.equal(rejectedTrade.decisionSource, "commissioner_api");
    assert.ok(Number.isFinite(Date.parse(rejectedTrade.decisionAt)));

    const ownershipAfterRejection = await loadSeasonOwnership(seasonId);
    assert.equal(
      ownershipAfterRejection.byBidder.get(auditSeller.id)?.get(auditTeam.id)?.effectiveShare ?? 0,
      0,
      "rejected correction removes the seller's signed trade position",
    );
    assert.equal(
      ownershipAfterRejection.byBidder.get(auditBuyer.id)?.get(auditTeam.id)?.effectiveShare ?? 0,
      0,
      "rejected correction removes the buyer's signed trade position",
    );

    const secondDecision = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ status: "approved", confirmed: true }),
    });
    assert.equal(secondDecision.status, 409, "a rejected trade cannot be decided again");

    const getTradesResponse = await fetch(`${baseUrl}/api/trades?season=${seasonYear}`);
    const listedTrade = (await getTradesResponse.json()).find((trade) => trade.id === createdTrade.id);
    assert.equal(listedTrade.status, "rejected");
    assert.equal(listedTrade.decisionSource, "commissioner_api");
    assert.notEqual(listedTrade.decisionAt, approvedTrade.decisionAt);
  });

  test("approves a zero-stake sale, preserves signed ownership, and supports an offsetting buy", async () => {
    for (const percentage of [-1, 0, 101]) {
      const response = await fetch(`${baseUrl}/api/trades`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seasonYear,
          teamId,
          fromBidderId: shortSeller.id,
          toBidderId: newBuyer.id,
          percentage,
          price: 100,
          tradeDate: "2030-01-01",
        }),
      });
      assert.equal(response.status, 400, `${percentage}% must be rejected`);
    }

    await assert.rejects(
      db
        .insert(tradesTable)
        .values({
          seasonId,
          teamId,
          fromBidderId: shortSeller.id,
          toBidderId: newBuyer.id,
          percentage: "0",
          price: "0",
          status: "pending",
          tradeDate: "2030-01-01",
        })
        .returning(),
      /failed query|violates/i,
      "database checks reject malformed trade rows even outside the API",
    );

    await createAndApproveTrade({
      fromBidderId: shortSeller.id,
      toBidderId: newBuyer.id,
      percentage: 100,
      price: 100,
    });

    let ownership = await loadSeasonOwnership(seasonId);
    assert.equal(ownership.byBidder.get(shortSeller.id).get(teamId).effectiveShare, -1);
    assert.equal(ownership.byBidder.get(newBuyer.id).get(teamId).effectiveShare, 1);
    assert.equal(
      teamEffectiveTotal(ownership, teamId),
      1,
      "the short and long legs offset while the team remains 100% owned",
    );
    assert.ok(ownership.participantIds.has(shortSeller.id));
    assert.ok(ownership.participantIds.has(newBuyer.id));
    const currentOwnerIds = ownership.currentOwnersByTeam
      .get(teamId)
      .map((owner) => owner.bidderId);
    assert.ok(
      currentOwnerIds.includes(newBuyer.id),
      "the trade buyer is presented as a current team owner",
    );
    assert.equal(
      currentOwnerIds.includes(shortSeller.id),
      false,
      "a short seller is never presented as a current team owner",
    );

    const ownerResultsResponse = await fetch(`${baseUrl}/api/results/by-owner?season=${seasonYear}`);
    assert.equal(ownerResultsResponse.status, 200);
    const ownerResults = await ownerResultsResponse.json();
    const shortSellerResult = ownerResults.find((owner) => owner.bidderId === shortSeller.id);
    assert.equal(shortSellerResult.teamCount, -1);
    assert.equal(shortSellerResult.totalCost, -100);
    assert.equal(shortSellerResult.teams[0].owners[0].ownershipShare, -1);

    await createAndApproveTrade({
      fromBidderId: newBuyer.id,
      toBidderId: shortSeller.id,
      percentage: 25,
      price: 25,
    });

    ownership = await loadSeasonOwnership(seasonId);
    assert.equal(ownership.byBidder.get(shortSeller.id).get(teamId).effectiveShare, -0.75);
    assert.equal(ownership.byBidder.get(newBuyer.id).get(teamId).effectiveShare, 0.75);
    assert.equal(teamEffectiveTotal(ownership, teamId), 1);

    const offsetOwnerResultsResponse = await fetch(`${baseUrl}/api/results/by-owner?season=${seasonYear}`);
    assert.equal(offsetOwnerResultsResponse.status, 200);
    const offsetOwnerResults = await offsetOwnerResultsResponse.json();
    assert.equal(
      offsetOwnerResults.find((owner) => owner.bidderId === shortSeller.id).teamCount,
      -0.75,
      "short position counts retain two decimal places",
    );
    assert.equal(
      offsetOwnerResults.find((owner) => owner.bidderId === newBuyer.id).teamCount,
      0.75,
      "long position counts retain two decimal places",
    );
  });

  test("voids an approved REST trade, removes its signed positions, and preserves audit history", async () => {
    const ownershipBeforeTrade = await loadSeasonOwnership(seasonId);
    const shortSellerBeforeTrade =
      ownershipBeforeTrade.byBidder.get(shortSeller.id)?.get(teamId)?.effectiveShare ?? 0;
    const newBuyerBeforeTrade =
      ownershipBeforeTrade.byBidder.get(newBuyer.id)?.get(teamId)?.effectiveShare ?? 0;
    const { createdTrade, approvedTrade } = await createAndApproveTrade({
      fromBidderId: shortSeller.id,
      toBidderId: newBuyer.id,
      percentage: 25,
      price: 25,
    });
    const ownershipWithTrade = await loadSeasonOwnership(seasonId);
    assert.equal(
      ownershipWithTrade.byBidder.get(shortSeller.id).get(teamId).effectiveShare,
      shortSellerBeforeTrade - 0.25,
    );
    assert.equal(
      ownershipWithTrade.byBidder.get(newBuyer.id).get(teamId).effectiveShare,
      newBuyerBeforeTrade + 0.25,
    );

    const missingReason = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ status: "voided", confirmed: true }),
    });
    assert.equal(missingReason.status, 400);

    const whitespaceReason = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ status: "voided", confirmed: true, reason: "   " }),
    });
    assert.equal(whitespaceReason.status, 400);

    const voidResponse = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        status: "voided",
        confirmed: true,
        reason: "Commissioner correction: duplicate submission",
      }),
    });
    const voidedTrade = await voidResponse.json();
    assert.equal(voidResponse.status, 200, JSON.stringify(voidedTrade));
    assert.equal(voidedTrade.status, "voided");
    assert.equal(voidedTrade.decisionAt, approvedTrade.decisionAt);
    assert.equal(voidedTrade.decisionSource, "commissioner_api");
    assert.equal(voidedTrade.voidedSource, "commissioner_api");
    assert.equal(voidedTrade.voidReason, "Commissioner correction: duplicate submission");
    assert.ok(Number.isFinite(Date.parse(voidedTrade.voidedAt)));

    const ownershipAfterVoid = await loadSeasonOwnership(seasonId);
    assert.equal(
      ownershipAfterVoid.byBidder.get(shortSeller.id)?.get(teamId)?.effectiveShare ?? 0,
      shortSellerBeforeTrade,
      "voided trade no longer creates a short position",
    );
    assert.equal(
      ownershipAfterVoid.byBidder.get(newBuyer.id)?.get(teamId)?.effectiveShare ?? 0,
      newBuyerBeforeTrade,
      "voided trade no longer creates a buyer position",
    );
    const storedLegs = await db
      .select({ id: positionsTable.id })
      .from(positionsTable)
      .where(eq(positionsTable.tradeId, createdTrade.id));
    assert.equal(storedLegs.length, 0, "position rebuild removes voided trade legs");

    const listedTrade = (await (await fetch(`${baseUrl}/api/trades?season=${seasonYear}`)).json())
      .find((trade) => trade.id === createdTrade.id);
    assert.equal(listedTrade.status, "voided", "the original trade remains visible");
    assert.equal(listedTrade.voidReason, voidedTrade.voidReason);

    const repeatedVoid = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        status: "voided",
        confirmed: true,
        reason: "Second attempt",
      }),
    });
    assert.equal(repeatedVoid.status, 409);
  });

  test("keeps primary shares separate from trade-derived positions in results", async () => {
    const [tradeSeller] = await db
      .insert(biddersTable)
      .values({ name: `Trade Seller ${seasonYear}` })
      .returning();
    createdBidderIds.push(tradeSeller.id);

    await createAndApproveTrade({
      fromBidderId: tradeSeller.id,
      toBidderId: primaryBuyer.id,
      percentage: 100,
      price: 100,
    });
    await createAndApproveTrade({
      fromBidderId: tradeSeller.id,
      toBidderId: primaryBuyer.id,
      percentage: 100,
      price: 100,
    });

    const resultsResponse = await fetch(`${baseUrl}/api/results?season=${seasonYear}`);
    assert.equal(resultsResponse.status, 200);
    const teamResult = (await resultsResponse.json()).find(
      (row) => row.teamId === teamId,
    );
    assert.ok(teamResult, "the team appears because the trade buyer has a long position");

    const primarySegment = teamResult.ownershipSegments.find(
      (segment) =>
        segment.source === "primary" && segment.bidderId === primaryBuyer.id,
    );
    assert.deepEqual(primarySegment, {
      bidderId: primaryBuyer.id,
      bidderName: primaryBuyer.name,
      ownershipShare: 0.5,
      source: "primary",
    });

    const acquiredSegments = teamResult.ownershipSegments.filter(
      (segment) =>
        segment.source === "trade" &&
        segment.tradeDirection === "acquired" &&
        segment.bidderId === primaryBuyer.id &&
        segment.counterpartyBidderId === tradeSeller.id,
    );
    assert.equal(acquiredSegments.length, 2);
    assert.equal(
      acquiredSegments.reduce((total, segment) => total + segment.ownershipShare, 0),
      2,
      "two approved trades are reported as a 200% trade-derived acquisition",
    );

    assert.equal(
      teamResult.owners.find((owner) => owner.bidderId === primaryBuyer.id)
        .ownershipShare,
      2.5,
      "the existing current-owner response remains the effective total",
    );
    const ownership = await loadSeasonOwnership(seasonId);
    assert.equal(teamEffectiveTotal(ownership, teamId), 1);

    const primaryRewrite = await fetch(`${baseUrl}/api/teams/${teamId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        season: seasonYear,
        owners: [{ bidderId: primaryOwner.id, ownershipShare: 1 }],
      }),
    });
    assert.equal(
      primaryRewrite.status,
      409,
      "approved trades prevent a later replacement of primary ownership",
    );
  });

  test("MCP decisions require confirmation, can correct approval to rejection, and preserve void auditing", { skip: !MCP_KEY }, async () => {
    const [mcpSeller] = await db
      .insert(biddersTable)
      .values({ name: `MCP Audit Seller ${seasonYear}` })
      .returning();
    const [mcpBuyer] = await db
      .insert(biddersTable)
      .values({ name: `MCP Audit Buyer ${seasonYear}` })
      .returning();
    createdBidderIds.push(mcpSeller.id, mcpBuyer.id);

    const createResponse = await fetch(`${baseUrl}/api/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seasonYear,
        teamId,
        fromBidderId: mcpSeller.id,
        toBidderId: mcpBuyer.id,
        percentage: 10,
        price: 10,
        tradeDate: "2030-01-01",
      }),
    });
    const pendingTrade = await createResponse.json();
    assert.equal(createResponse.status, 201, JSON.stringify(pendingTrade));

    const missingConfirmation = await callMcpTool("set_trade_status", {
      tradeId: pendingTrade.id,
      status: "approved",
      adminKey: ADMIN_KEY,
    });
    assert.match(
      JSON.stringify(missingConfirmation),
      /confirmed/i,
      "MCP rejects a decision without explicit confirmation",
    );

    const approved = await callMcpTool("set_trade_status", {
      tradeId: pendingTrade.id,
      status: "approved",
      confirmed: true,
      adminKey: ADMIN_KEY,
    });
    assert.match(JSON.stringify(approved), /APPROVED/);

    const correctedToRejected = await callMcpTool("set_trade_status", {
      tradeId: pendingTrade.id,
      status: "rejected",
      confirmed: true,
      adminKey: ADMIN_KEY,
    });
    assert.match(JSON.stringify(correctedToRejected), /REJECTED/);

    const [storedTrade] = await db
      .select({
        status: tradesTable.status,
        decisionAt: tradesTable.decisionAt,
        decisionSource: tradesTable.decisionSource,
        voidedAt: tradesTable.voidedAt,
        voidedSource: tradesTable.voidedSource,
        voidReason: tradesTable.voidReason,
      })
      .from(tradesTable)
      .where(eq(tradesTable.id, pendingTrade.id));
    assert.equal(storedTrade.status, "rejected");
    assert.equal(storedTrade.decisionSource, "commissioner_mcp");
    assert.ok(storedTrade.decisionAt instanceof Date);
    assert.equal(storedTrade.voidedAt, null);
    const rejectedTradeLegs = await db
      .select({ id: positionsTable.id })
      .from(positionsTable)
      .where(eq(positionsTable.tradeId, pendingTrade.id));
    assert.equal(rejectedTradeLegs.length, 0, "MCP rejection removes signed trade legs");

    const voidTradeResponse = await fetch(`${baseUrl}/api/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seasonYear,
        teamId,
        fromBidderId: mcpSeller.id,
        toBidderId: mcpBuyer.id,
        percentage: 10,
        price: 10,
        tradeDate: "2030-01-01",
      }),
    });
    const voidableTrade = await voidTradeResponse.json();
    assert.equal(voidTradeResponse.status, 201, JSON.stringify(voidableTrade));
    const voidApproval = await callMcpTool("set_trade_status", {
      tradeId: voidableTrade.id,
      status: "approved",
      confirmed: true,
      adminKey: ADMIN_KEY,
    });
    assert.match(JSON.stringify(voidApproval), /APPROVED/);

    const missingReasonVoid = await callMcpTool("set_trade_status", {
      tradeId: voidableTrade.id,
      status: "voided",
      confirmed: true,
      adminKey: ADMIN_KEY,
    });
    assert.match(JSON.stringify(missingReasonVoid), /reason/i);

    const voided = await callMcpTool("set_trade_status", {
      tradeId: voidableTrade.id,
      status: "voided",
      confirmed: true,
      reason: "MCP correction of an incorrectly approved trade",
      adminKey: ADMIN_KEY,
    });
    assert.match(JSON.stringify(voided), /VOIDED/);
    const [voidedStoredTrade] = await db
      .select({
        status: tradesTable.status,
        decisionSource: tradesTable.decisionSource,
        voidedAt: tradesTable.voidedAt,
        voidedSource: tradesTable.voidedSource,
        voidReason: tradesTable.voidReason,
      })
      .from(tradesTable)
      .where(eq(tradesTable.id, voidableTrade.id));
    assert.equal(voidedStoredTrade.status, "voided");
    assert.equal(voidedStoredTrade.decisionSource, "commissioner_mcp");
    assert.equal(voidedStoredTrade.voidedSource, "commissioner_mcp");
    assert.equal(voidedStoredTrade.voidReason, "MCP correction of an incorrectly approved trade");
    assert.ok(voidedStoredTrade.voidedAt instanceof Date);
    const voidedTradeLegs = await db
      .select({ id: positionsTable.id })
      .from(positionsTable)
      .where(eq(positionsTable.tradeId, voidableTrade.id));
    assert.equal(voidedTradeLegs.length, 0, "MCP void removes signed trade legs");
  });
});