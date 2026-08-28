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
let runDatabaseMigrations;

if (canRun) {
  ({ default: app } = await import("../app.ts"));
  ({
    db,
    mcpOauthClientsTable,
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

    const adminKeyRequest = await requestMcp(baseUrl, ADMIN_KEY);
    assert.equal(adminKeyRequest.status, 401);
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
    assert.match(await authorizationPage.text(), /MCP API key/);
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
});