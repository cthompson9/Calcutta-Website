/**
 * OAuth integration coverage for Claude's URL-only remote MCP connector.
 *
 * The browser approval page verifies MCP_API_KEY, then PKCE protects the
 * client exchange. Raw OAuth credentials are never persisted by this test.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
const MCP_KEY = process.env.MCP_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const canRun = Boolean(DATABASE_URL && MCP_KEY && SESSION_SECRET && ADMIN_KEY);

let app;
let db;
let mcpOauthClientsTable;
let mcpOauthAuthorizationCodesTable;
let mcpOauthTokensTable;
let runDatabaseMigrations;

if (canRun) {
  ({ default: app } = await import("../app.ts"));
  ({
    db,
    mcpOauthClientsTable,
    mcpOauthAuthorizationCodesTable,
    mcpOauthTokensTable,
    runDatabaseMigrations,
  } = await import("@workspace/db"));
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

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function firstCookie(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "authorization response should set an approval cookie");
  return header.split(";")[0];
}

async function requestMcp(baseUrl, token) {
  return fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
}

async function requestMcpWithApiKeyHeader(baseUrl) {
  return fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-API-Key": MCP_KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
}

async function callMcpTool(baseUrl, token, name, args) {
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
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
  return JSON.parse(json);
}

const PRIVILEGED_MCP_CALLS = [
  ["import_nfl_standings", { confirmed: true }],
  ["set_bidder_consortium", { bidder: "Missing bidder", consortium: null }],
  ["set_team_primary_ownership", {
    team: "Missing team",
    owners: [{ owner: "Missing owner", share: 1 }],
  }],
  ["set_trade_status", { tradeId: 2_147_483_647, status: "rejected", confirmed: true }],
  ["set_team_period_snapshot", {
    team: "Missing team",
    season: 2099,
    period: 0,
    basis: "realized",
  }],
  ["set_calcutta_payout_rules", {
    season: 2099,
    rules: [{ metric: "win", dollarsPerUnit: 1, playoffMultiplier: 2 }],
  }],
  ["set_team_seed", { team: "Missing team", seed: null }],
  ["set_team_mtm", { team: "Missing team", mtmValue: 1 }],
];

const PUBLIC_MCP_PROPOSALS = [
  ["create_trade", {
    team: "Missing team",
    fromOwner: "Missing seller",
    toOwner: "Missing buyer",
  }],
];

describe("MCP OAuth authorization", { skip: !canRun }, () => {
  let server;
  let baseUrl;
  let clientId;

  before(async () => {
    await runDatabaseMigrations();
    ({ server, baseUrl } = await startServer(app));
  });

  after(async () => {
    if (clientId) {
      await db.delete(mcpOauthClientsTable).where(eq(mcpOauthClientsTable.clientId, clientId));
    }
    await stopServer(server);
  });

  test("publishes discovery and preserves static MCP bearer authentication", async () => {
    const resourceResponse = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/api/mcp`,
    );
    assert.equal(resourceResponse.status, 200);
    const resourceMetadata = await resourceResponse.json();
    assert.equal(resourceMetadata.resource, `${baseUrl}/api/mcp`);
    assert.deepEqual(resourceMetadata.authorization_servers, [baseUrl]);

    const authorizationServerResponse = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    assert.equal(authorizationServerResponse.status, 200);
    const authorizationMetadata = await authorizationServerResponse.json();
    assert.equal(authorizationMetadata.authorization_endpoint, `${baseUrl}/api/mcp/oauth/authorize`);
    assert.equal(authorizationMetadata.token_endpoint, `${baseUrl}/api/mcp/oauth/token`);
    assert.equal(authorizationMetadata.registration_endpoint, `${baseUrl}/api/mcp/oauth/register`);
    assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ["S256"]);

    const unauthenticated = await requestMcp(baseUrl);
    assert.equal(unauthenticated.status, 401);
    assert.match(
      unauthenticated.headers.get("www-authenticate") ?? "",
      new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.well-known/oauth-protected-resource/api/mcp`),
    );

    const staticKeyRequest = await requestMcp(baseUrl, MCP_KEY);
    assert.equal(staticKeyRequest.status, 200);
    const staticHeaderRequest = await requestMcpWithApiKeyHeader(baseUrl);
    assert.equal(staticHeaderRequest.status, 200);

    const adminKeyRequest = await requestMcp(baseUrl, ADMIN_KEY);
    assert.equal(adminKeyRequest.status, 200);

    for (const [name, args] of PRIVILEGED_MCP_CALLS) {
      const denied = await callMcpTool(baseUrl, MCP_KEY, name, args);
      assert.equal(denied.result?.isError, true, name);
      assert.match(denied.result.content[0].text, /Commissioner authorization is required/, name);
    }

    const readable = await callMcpTool(baseUrl, MCP_KEY, "get_team_cost", {
      team: "Missing team",
      season: 2099,
    });
    assert.notEqual(readable.result?.isError, true);

    for (const [name, args] of PUBLIC_MCP_PROPOSALS) {
      const proposal = await callMcpTool(baseUrl, MCP_KEY, name, args);
      assert.notEqual(proposal.result?.isError, true, name);
      assert.doesNotMatch(proposal.result?.content?.[0]?.text ?? "", /Commissioner authorization is required/, name);
    }

    const adminMutation = await callMcpTool(baseUrl, ADMIN_KEY, "set_team_seed", {
      team: "Missing team",
      seed: null,
    });
    assert.notEqual(adminMutation.result?.isError, true);
    assert.match(adminMutation.result.content[0].text, /Team not found/);
  });

  test("exchanges MCP-key approval for revocable OAuth credentials", async () => {
    const redirectUri = "http://127.0.0.1:45871/callback";
    const registration = await fetch(`${baseUrl}/api/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.1" },
      body: JSON.stringify({
        client_name: "Calcutta OAuth test client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    clientId = client.client_id;
    assert.ok(clientId);

    const { verifier, challenge } = createPkcePair();
    const authorizationUrl = new URL(`${baseUrl}/api/mcp/oauth/authorize`);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("scope", "mcp");
    authorizationUrl.searchParams.set("resource", `${baseUrl}/api/mcp`);
    authorizationUrl.searchParams.set("state", "test-state");

    const authorizationPage = await fetch(authorizationUrl, {
      redirect: "manual",
      headers: { "X-Forwarded-For": "198.51.100.1" },
    });
    assert.equal(authorizationPage.status, 200);
    assert.equal(authorizationPage.headers.get("content-security-policy"), null);
    const authorizationHtml = await authorizationPage.text();
    assert.match(authorizationHtml, /MCP API key/);
    assert.match(authorizationHtml, /<form method="post" action="" autocomplete="off">/);
    const cookie = firstCookie(authorizationPage);

    const adminApproval = await fetch(`${baseUrl}/api/mcp/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        "X-Forwarded-For": "198.51.100.1",
      },
      body: new URLSearchParams({
        decision: "approve",
        mcpApiKey: ADMIN_KEY,
      }),
    });
    assert.equal(adminApproval.status, 401);
    assert.match(await adminApproval.text(), /not accepted/);

    const approved = await fetch(`${baseUrl}/api/mcp/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        "X-Forwarded-For": "198.51.100.1",
      },
      body: new URLSearchParams({
        decision: "approve",
        mcpApiKey: MCP_KEY,
      }),
    });
    assert.equal(approved.status, 302);
    const callback = new URL(approved.headers.get("location"));
    assert.equal(callback.origin, "http://127.0.0.1:45871");
    assert.equal(callback.searchParams.get("state"), "test-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const exchange = await fetch(`${baseUrl}/api/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.1" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.scope, "mcp");

    const oauthRequest = await requestMcp(baseUrl, tokens.access_token);
    assert.equal(oauthRequest.status, 200);
    for (const [name, args] of PRIVILEGED_MCP_CALLS) {
      const oauthMutation = await callMcpTool(baseUrl, tokens.access_token, name, args);
      assert.equal(oauthMutation.result?.isError, true, name);
      assert.match(
        oauthMutation.result.content[0].text,
        /Commissioner authorization is required/,
        name,
      );
    }
    for (const [name, args] of PUBLIC_MCP_PROPOSALS) {
      const proposal = await callMcpTool(baseUrl, tokens.access_token, name, args);
      assert.notEqual(proposal.result?.isError, true, name);
      assert.doesNotMatch(proposal.result?.content?.[0]?.text ?? "", /Commissioner authorization is required/, name);
    }

    await db
      .update(mcpOauthClientsTable)
      .set({ createdAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(mcpOauthClientsTable.clientId, clientId));

    const replay = await fetch(`${baseUrl}/api/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.2" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");

    const refresh = await fetch(`${baseUrl}/api/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.2" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    assert.equal(refresh.status, 200);
    const refreshedTokens = await refresh.json();
    assert.ok(refreshedTokens.access_token);
    assert.notEqual(refreshedTokens.access_token, tokens.access_token);

    const revoke = await fetch(`${baseUrl}/api/mcp/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.2" },
      body: new URLSearchParams({
        client_id: clientId,
        token: refreshedTokens.access_token,
      }),
    });
    assert.equal(revoke.status, 200);
    const revokedRequest = await requestMcp(baseUrl, refreshedTokens.access_token);
    assert.equal(revokedRequest.status, 401);
  });

  test("registration preserves previously registered clients", async () => {
    const old = new Date("2000-01-01T00:00:00.000Z");
    const future = new Date(Date.now() + 60_000);
    const inactiveId = `stale_${Date.now()}`;
    const activeId = `active_${Date.now()}`;
    await db.insert(mcpOauthClientsTable).values([
      { clientId: inactiveId, redirectUris: ["https://example.test/inactive"], createdAt: old },
      { clientId: activeId, redirectUris: ["https://example.test/active"], createdAt: old },
    ]);
    await db.insert(mcpOauthTokensTable).values({
      tokenHash: `test_${activeId}`,
      tokenType: "access",
      clientId: activeId,
      scope: "mcp",
      resource: `${baseUrl}/api/mcp`,
      expiresAt: future,
    });
    const response = await fetch(`${baseUrl}/api/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.91" },
      body: JSON.stringify({ redirect_uris: ["https://example.test/new"] }),
    });
    assert.equal(response.status, 201);
    assert.equal((await db.select().from(mcpOauthClientsTable).where(eq(mcpOauthClientsTable.clientId, inactiveId))).length, 1);
    assert.equal((await db.select().from(mcpOauthClientsTable).where(eq(mcpOauthClientsTable.clientId, activeId))).length, 1);
  });

  test("long-lived registrations remain usable while codes and tokens retain expiry semantics", async () => {
    const redirectUri = "https://example.test/callback";
    const register = async (ip) => {
      const response = await fetch(`${baseUrl}/api/mcp/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      assert.equal(response.status, 201);
      return (await response.json()).client_id;
    };
    const authorizationUrl = (clientId, challenge) => {
      const url = new URL(`${baseUrl}/api/mcp/oauth/authorize`);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    };
    const getClient = await register("198.51.100.92");
    await db.update(mcpOauthClientsTable)
      .set({ createdAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(mcpOauthClientsTable.clientId, getClient));
    const delayedPage = await fetch(authorizationUrl(getClient, createPkcePair().challenge));
    assert.equal(delayedPage.status, 200);

    const approvalClient = await register("198.51.100.93");
    const approvalPkce = createPkcePair();
    const approvalPage = await fetch(authorizationUrl(approvalClient, approvalPkce.challenge));
    const approvalCookie = firstCookie(approvalPage);
    await db.update(mcpOauthClientsTable)
      .set({ createdAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(mcpOauthClientsTable.clientId, approvalClient));
    const approval = await fetch(`${baseUrl}/api/mcp/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: approvalCookie },
      body: new URLSearchParams({ decision: "approve", mcpApiKey: MCP_KEY }),
    });
    assert.equal(approval.status, 302);

    const tokenClient = await register("198.51.100.94");
    const tokenPkce = createPkcePair();
    const tokenPage = await fetch(authorizationUrl(tokenClient, tokenPkce.challenge));
    const tokenApproval = await fetch(`${baseUrl}/api/mcp/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: firstCookie(tokenPage) },
      body: new URLSearchParams({ decision: "approve", mcpApiKey: MCP_KEY }),
    });
    const code = new URL(tokenApproval.headers.get("location")).searchParams.get("code");
    await db.update(mcpOauthClientsTable)
      .set({ createdAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(mcpOauthClientsTable.clientId, tokenClient));
    const token = await fetch(`${baseUrl}/api/mcp/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Forwarded-For": "198.51.100.95",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: tokenClient,
        redirect_uri: redirectUri,
        code,
        code_verifier: tokenPkce.verifier,
      }),
    });
    assert.equal(token.status, 200);
    assert.ok((await token.json()).refresh_token);
  });
});