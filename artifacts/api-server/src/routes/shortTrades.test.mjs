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
import { eq, inArray } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const canRun = Boolean(DATABASE_URL && ADMIN_KEY);

let db;
let biddersTable;
let seasonsTable;
let teamsTable;
let teamSeasonAuctionsTable;
let tradesTable;
let app;
let loadSeasonOwnership;
let resolveOrCreateBidder;

if (canRun) {
  ({
    db,
    biddersTable,
    seasonsTable,
    teamsTable,
    teamSeasonAuctionsTable,
    tradesTable,
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

  async function createAndApproveTrade({ fromBidderId, toBidderId, percentage, price }) {
    const createResponse = await fetch(`${baseUrl}/api/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seasonYear,
        teamId,
        fromBidderId,
        toBidderId,
        percentage,
        price,
        tradeDate: "2030-01-01",
      }),
    });
    const createdTrade = await createResponse.json();
    assert.equal(createResponse.status, 201, JSON.stringify(createdTrade));

    const approvalResponse = await fetch(`${baseUrl}/api/trades/${createdTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ status: "approved" }),
    });
    assert.equal(approvalResponse.status, 200, await approvalResponse.text());
  }

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

    const [malformedPendingTrade] = await db
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
      .returning();
    const malformedApproval = await fetch(`${baseUrl}/api/trades/${malformedPendingTrade.id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ status: "approved" }),
    });
    assert.equal(malformedApproval.status, 400, "approval rejects malformed pending percentages");

    await createAndApproveTrade({
      fromBidderId: shortSeller.id,
      toBidderId: newBuyer.id,
      percentage: 100,
      price: 100,
    });

    let ownership = await loadSeasonOwnership(seasonId);
    assert.equal(ownership.byBidder.get(shortSeller.id).get(teamId).effectiveShare, -1);
    assert.equal(ownership.byBidder.get(newBuyer.id).get(teamId).effectiveShare, 1);
    assert.ok(ownership.participantIds.has(shortSeller.id));
    assert.ok(ownership.participantIds.has(newBuyer.id));
    assert.deepEqual(
      ownership.currentOwnersByTeam.get(teamId).map((owner) => owner.bidderId),
      [newBuyer.id],
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
  });
});