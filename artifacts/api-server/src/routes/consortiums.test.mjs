import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const MCP_KEY = process.env.MCP_API_KEY;
const canRun = Boolean(DATABASE_URL && ADMIN_KEY && MCP_KEY);

let db;
let biddersTable;
let consortiaTable;
let app;

if (canRun) {
  ({ db, biddersTable, consortiaTable } = await import("@workspace/db"));
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
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const json = body.trim().startsWith("event:")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : body;
  assert.ok(json, body);
  return JSON.parse(json);
}

function mcpText(response) {
  return response.result?.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("bidder consortiums", { skip: !canRun }, () => {
  let bidder;
  let secondBidder;
  let server;
  let baseUrl;
  let consortium;

  before(async () => {
    const uniqueName = `Consortium Fixture Bidder ${Date.now()}`;
    [bidder] = await db
      .insert(biddersTable)
      .values({ name: uniqueName })
      .returning();
    [secondBidder] = await db
      .insert(biddersTable)
      .values({ name: `Consortium Fixture Partner ${Date.now()}` })
      .returning();
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (server) await stopServer(server);
    if (bidder && secondBidder) {
      await db
        .delete(biddersTable)
        .where(inArray(biddersTable.id, [bidder.id, secondBidder.id]));
    }
    if (consortium) {
      await db.delete(consortiaTable).where(eq(consortiaTable.id, consortium.id));
    }
  });

  test("lists, assigns, reads, and clears a bidder consortium through MCP", async () => {
    const listResponse = await fetch(`${baseUrl}/api/bidders`);
    assert.equal(listResponse.status, 200);
    const initialBidders = await listResponse.json();
    assert.deepEqual(
      initialBidders.find((entry) => entry.id === bidder.id),
      {
        id: bidder.id,
        name: bidder.name,
        consortium: null,
        teamCount: 0,
        totalPaid: 0,
        teams: [],
      },
    );

    const initialize = await mcpRequest(baseUrl, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "consortium-test", version: "1.0.0" },
    });
    assert.equal(initialize.result?.serverInfo?.name, "nfl-auction");

    const tools = await mcpRequest(baseUrl, 2, "tools/list");
    const toolNames = tools.result.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("get_bidder_consortium"));
    assert.ok(toolNames.includes("set_bidder_consortium"));

    const unauthorized = await mcpRequest(baseUrl, 3, "tools/call", {
      name: "set_bidder_consortium",
      arguments: {
        bidder: bidder.name,
        consortium: "Should Not Save",
        adminKey: "incorrect",
      },
    });
    assert.match(mcpText(unauthorized), /invalid admin key/i);

    const consortiumName = `Cleanup Group ${Date.now()}`;
    const assigned = await mcpRequest(baseUrl, 4, "tools/call", {
      name: "set_bidder_consortium",
      arguments: {
        bidder: bidder.name,
        consortium: `  Cleanup   Group ${consortiumName.split(" ").pop()}  `,
        adminKey: ADMIN_KEY,
      },
    });
    assert.equal(mcpText(assigned), `Consortium set: ${bidder.name} → ${consortiumName}.`);

    [consortium] = await db
      .select()
      .from(consortiaTable)
      .where(eq(consortiaTable.name, consortiumName));
    assert.ok(consortium);

    const reused = await mcpRequest(baseUrl, 5, "tools/call", {
      name: "set_bidder_consortium",
      arguments: {
        bidder: secondBidder.name,
        consortium: consortiumName.toLowerCase(),
        adminKey: ADMIN_KEY,
      },
    });
    assert.equal(mcpText(reused), `Consortium set: ${secondBidder.name} → ${consortiumName}.`);
    const [secondStoredBidder] = await db
      .select({ consortiumId: biddersTable.consortiumId })
      .from(biddersTable)
      .where(eq(biddersTable.id, secondBidder.id));
    assert.equal(secondStoredBidder.consortiumId, consortium.id);

    await assert.rejects(
      db.insert(consortiaTable).values({ name: consortiumName.toLowerCase() }),
      (error) => /duplicate key/i.test(error.cause?.message ?? error.message),
    );

    const fetched = await mcpRequest(baseUrl, 5, "tools/call", {
      name: "get_bidder_consortium",
      arguments: { bidder: bidder.name.toLowerCase() },
    });
    assert.equal(mcpText(fetched), consortiumName);

    const listedResponse = await fetch(`${baseUrl}/api/bidders`);
    const listedBidders = await listedResponse.json();
    assert.equal(
      listedBidders.find((entry) => entry.id === bidder.id).consortium,
      consortiumName,
    );

    const cleared = await mcpRequest(baseUrl, 6, "tools/call", {
      name: "set_bidder_consortium",
      arguments: {
        bidder: bidder.name,
        consortium: null,
        adminKey: ADMIN_KEY,
      },
    });
    assert.equal(mcpText(cleared), `Consortium cleared: ${bidder.name}.`);

    const afterClear = await mcpRequest(baseUrl, 7, "tools/call", {
      name: "get_bidder_consortium",
      arguments: { bidder: bidder.name },
    });
    assert.equal(mcpText(afterClear), "null");

    const ambiguous = await mcpRequest(baseUrl, 8, "tools/call", {
      name: "get_bidder_consortium",
      arguments: { bidder: "Consortium Fixture" },
    });
    assert.match(mcpText(ambiguous), /ambiguous/i);

    const unknown = await mcpRequest(baseUrl, 9, "tools/call", {
      name: "get_bidder_consortium",
      arguments: { bidder: "No Such Bidder" },
    });
    assert.match(mcpText(unknown), /not found/i);
  });
});