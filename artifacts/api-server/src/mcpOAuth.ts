import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  and,
  eq,
  gt,
  isNull,
  lt,
  notExists,
} from "drizzle-orm";
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  mcpOauthAuthorizationCodesTable,
  mcpOauthClientsTable,
  mcpOauthTokensTable,
} from "@workspace/db";

const AUTHORIZATION_COOKIE = "calcutta_mcp_authorization";
const AUTHORIZATION_COOKIE_MAX_AGE_MS = 10 * 60 * 1_000;
const AUTHORIZATION_CODE_LIFETIME_MS = 5 * 60 * 1_000;
const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const AUTHORIZATION_SCOPE = "mcp";
const UNUSED_CLIENT_LIFETIME_MS = 24 * 60 * 60 * 1_000;

function isExpiredClient(client: { createdAt: Date }): boolean {
  return client.createdAt.getTime() <= Date.now() - UNUSED_CLIENT_LIFETIME_MS;
}

async function isExpiredUnusedClient(client: { clientId: string; createdAt: Date }): Promise<boolean> {
  if (!isExpiredClient(client)) return false;
  const now = new Date();
  const activeToken = await db
    .select({ clientId: mcpOauthTokensTable.clientId })
    .from(mcpOauthTokensTable)
    .where(and(
      eq(mcpOauthTokensTable.clientId, client.clientId),
      isNull(mcpOauthTokensTable.revokedAt),
      gt(mcpOauthTokensTable.expiresAt, now),
    ))
    .limit(1);
  if (activeToken[0]) return false;

  const activeCode = await db
    .select({ clientId: mcpOauthAuthorizationCodesTable.clientId })
    .from(mcpOauthAuthorizationCodesTable)
    .where(and(
      eq(mcpOauthAuthorizationCodesTable.clientId, client.clientId),
      isNull(mcpOauthAuthorizationCodesTable.usedAt),
      gt(mcpOauthAuthorizationCodesTable.expiresAt, now),
    ))
    .limit(1);
  return !activeCode[0];
}

type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  resource: string;
  expiresAt: number;
};

type OAuthTokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
};

function publicOrigin(req: Request): string {
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.get("host") || "nfl-calcutta.replit.app";
  const forwardedProtocol = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const protocol = forwardedProtocol === "https" || (!isLocalhost && forwardedProtocol !== "http")
    ? "https"
    : "http";
  return `${protocol}://${host}`;
}

function resourceUrl(req: Request): string {
  return `${publicOrigin(req)}/api/mcp`;
}

export function mcpProtectedResourceMetadataUrl(req: Request): string {
  return `${publicOrigin(req)}/.well-known/oauth-protected-resource/api/mcp`;
}

function oauthEndpoint(req: Request, path: string): string {
  return `${publicOrigin(req)}/api/mcp/oauth${path}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function safelyMatches(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && timingSafeEqual(valueBuffer, expectedBuffer);
}

export function matchesMcpApiKey(value: string): boolean {
  const expected = process.env["MCP_API_KEY"];
  return Boolean(expected && safelyMatches(value, expected));
}

export function matchesAdminApiKey(value: string): boolean {
  const expected = process.env["ADMIN_API_KEY"];
  const mcpApiKey = process.env["MCP_API_KEY"];
  return Boolean(
    expected &&
    expected !== mcpApiKey &&
    safelyMatches(value, expected),
  );
}

function currentFlowSecret(): string | null {
  return process.env["SESSION_SECRET"] ?? null;
}

function signedAuthorizationRequest(request: AuthorizationRequest): string | null {
  const secret = currentFlowSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify(request)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readSignedAuthorizationRequest(value: string | undefined): AuthorizationRequest | null {
  const secret = currentFlowSecret();
  if (!value || !secret) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safelyMatches(signature, expectedSignature)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthorizationRequest;
    if (
      !parsed.clientId ||
      !parsed.redirectUri ||
      !parsed.codeChallenge ||
      !parsed.resource ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt < Date.now()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  return raw
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function shouldUseSecureCookie(req: Request): boolean {
  return process.env.NODE_ENV === "production" || req.header("x-forwarded-proto") === "https";
}

function setAuthorizationCookie(
  req: Request,
  res: Response,
  value: string,
): void {
  res.cookie(AUTHORIZATION_COOKIE, value, {
    httpOnly: true,
    secure: shouldUseSecureCookie(req),
    sameSite: "lax",
    path: "/api/mcp/oauth",
    maxAge: AUTHORIZATION_COOKIE_MAX_AGE_MS,
  });
}

function clearAuthorizationCookie(req: Request, res: Response): void {
  res.clearCookie(AUTHORIZATION_COOKIE, {
    httpOnly: true,
    secure: shouldUseSecureCookie(req),
    sameSite: "lax",
    path: "/api/mcp/oauth",
  });
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAuthorizationPage(
  res: Response,
  {
    clientName,
    error,
  }: {
    clientName: string;
    error?: string;
  },
): void {
  res
    .set("Cache-Control", "no-store")
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Connect Claude to Calcutta</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f4; color: #1c1917; }
      main { width: min(100% - 2rem, 29rem); box-sizing: border-box; background: #fff; border: 1px solid #d6d3d1; padding: 2rem; box-shadow: 0 16px 40px rgba(28,25,23,.12); }
      h1 { margin: 0 0 .6rem; font-size: 1.55rem; letter-spacing: -.02em; }
      p { line-height: 1.55; color: #57534e; }
      label { display: block; margin: 1.5rem 0 .45rem; font-weight: 700; }
      input { width: 100%; box-sizing: border-box; padding: .75rem; border: 1px solid #a8a29e; border-radius: .25rem; font: inherit; }
      .buttons { display: flex; justify-content: flex-end; gap: .75rem; margin-top: 1.5rem; }
      button { border: 0; border-radius: .25rem; padding: .72rem 1rem; font: inherit; font-weight: 700; cursor: pointer; }
      .cancel { background: #e7e5e4; color: #292524; }
      .approve { background: #1c1917; color: #fff; }
      .notice { border-left: 3px solid #57534e; padding-left: .75rem; font-size: .9rem; }
      .error { margin-top: 1rem; border-left-color: #b91c1c; color: #991b1b; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect Calcutta to Claude</h1>
      <p><strong>${htmlEscape(clientName)}</strong> is requesting access to the Calcutta MCP tools.</p>
      <p class="notice">Enter the <strong>MCP API key</strong> only. The commissioner admin key is never requested for this connection.</p>
      ${error ? `<p class="notice error">${htmlEscape(error)}</p>` : ""}
      <form method="post" action="/api/mcp/oauth/authorize" autocomplete="off">
        <label for="mcpApiKey">MCP API key</label>
        <input id="mcpApiKey" name="mcpApiKey" type="password" required autofocus autocomplete="off">
        <div class="buttons">
          <button class="cancel" type="submit" name="decision" value="deny">Cancel</button>
          <button class="approve" type="submit" name="decision" value="approve">Connect</button>
        </div>
      </form>
    </main>
  </body>
</html>`);
}

function sendOAuthError(
  res: Response,
  status: number,
  error: string,
  description: string,
): void {
  res
    .status(status)
    .set("Cache-Control", "no-store")
    .json({ error, error_description: description });
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "http:" && loopback;
  } catch {
    return false;
  }
}

function hasAllowedScope(rawScope: string | undefined): string | null {
  const scopes = (rawScope ?? AUTHORIZATION_SCOPE).split(/\s+/).filter(Boolean);
  if (scopes.length === 0 || scopes.some((scope) => scope !== AUTHORIZATION_SCOPE)) return null;
  return AUTHORIZATION_SCOPE;
}

function isValidS256Challenge(challenge: string | undefined): challenge is string {
  return Boolean(challenge && /^[A-Za-z0-9_-]{43,128}$/.test(challenge));
}

function verifyPkce(verifier: string, expectedChallenge: string): boolean {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return safelyMatches(challenge, expectedChallenge);
}

function redirectWithError(
  res: Response,
  redirectUri: string,
  error: string,
  state?: string,
): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state) target.searchParams.set("state", state);
  res.redirect(302, target.toString());
}

async function issueTokenPair(
  clientId: string,
  resource: string,
  scope: string,
): Promise<OAuthTokenPair> {
  const accessToken = randomToken("mcp_at_");
  const refreshToken = randomToken("mcp_rt_");
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_LIFETIME_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS);

  await db.insert(mcpOauthTokensTable).values([
    {
      tokenHash: digest(accessToken),
      tokenType: "access",
      clientId,
      scope,
      resource,
      expiresAt: accessExpiresAt,
    },
    {
      tokenHash: digest(refreshToken),
      tokenType: "refresh",
      clientId,
      scope,
      resource,
      expiresAt: refreshExpiresAt,
    },
  ]);

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_LIFETIME_MS / 1_000,
    scope,
  };
}

export async function verifyMcpOAuthAccessToken(
  token: string,
): Promise<{ scope: string; isAdmin: false } | null> {
  const now = new Date();
  const rows = await db
    .select({
      tokenHash: mcpOauthTokensTable.tokenHash,
      scope: mcpOauthTokensTable.scope,
    })
    .from(mcpOauthTokensTable)
    .where(and(
      eq(mcpOauthTokensTable.tokenHash, digest(token)),
      eq(mcpOauthTokensTable.tokenType, "access"),
      isNull(mcpOauthTokensTable.revokedAt),
      gt(mcpOauthTokensTable.expiresAt, now),
    ))
    .limit(1);
  return rows[0] ? { scope: rows[0].scope, isAdmin: false } : null;
}

export function createMcpOAuthRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/.well-known/oauth-protected-resource/api/mcp", (req, res): void => {
    res
      .set("Cache-Control", "no-store")
      .json({
        resource: resourceUrl(req),
        authorization_servers: [publicOrigin(req)],
        scopes_supported: [AUTHORIZATION_SCOPE],
        bearer_methods_supported: ["header"],
        resource_name: "Calcutta MCP",
      });
  });

  router.get("/.well-known/oauth-authorization-server", (req, res): void => {
    res
      .set("Cache-Control", "no-store")
      .json({
        issuer: publicOrigin(req),
        authorization_endpoint: oauthEndpoint(req, "/authorize"),
        token_endpoint: oauthEndpoint(req, "/token"),
        registration_endpoint: oauthEndpoint(req, "/register"),
        revocation_endpoint: oauthEndpoint(req, "/revoke"),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [AUTHORIZATION_SCOPE],
      });
  });

  router.post("/api/mcp/oauth/register", async (req, res): Promise<void> => {
    const redirectUris = req.body?.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > 8 ||
      redirectUris.some((uri) => typeof uri !== "string" || !validRedirectUri(uri))
    ) {
      sendOAuthError(res, 400, "invalid_client_metadata", "Provide one or more valid HTTPS redirect URIs.");
      return;
    }

    // Dynamic registration is intentionally short-lived until the client
    // completes a flow. This bounds abandoned public-client records.
    const staleBefore = new Date(Date.now() - UNUSED_CLIENT_LIFETIME_MS);
    const now = new Date();
    await db.delete(mcpOauthClientsTable).where(and(
      lt(mcpOauthClientsTable.createdAt, staleBefore),
      notExists(db.select({ clientId: mcpOauthTokensTable.clientId })
        .from(mcpOauthTokensTable)
        .where(and(
          eq(mcpOauthTokensTable.clientId, mcpOauthClientsTable.clientId),
          isNull(mcpOauthTokensTable.revokedAt),
          gt(mcpOauthTokensTable.expiresAt, now),
        ))),
      notExists(db.select({ clientId: mcpOauthAuthorizationCodesTable.clientId })
        .from(mcpOauthAuthorizationCodesTable)
        .where(and(
          eq(mcpOauthAuthorizationCodesTable.clientId, mcpOauthClientsTable.clientId),
          isNull(mcpOauthAuthorizationCodesTable.usedAt),
          gt(mcpOauthAuthorizationCodesTable.expiresAt, now),
        ))),
    ));
    const clientName = typeof req.body?.client_name === "string"
      ? req.body.client_name.trim().slice(0, 200)
      : null;
    const clientId = randomToken("mcp_client_");
    await db.insert(mcpOauthClientsTable).values({
      clientId,
      redirectUris,
      clientName: clientName || null,
    });

    res
      .status(201)
      .set("Cache-Control", "no-store")
      .json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1_000),
        redirect_uris: redirectUris,
        client_name: clientName || undefined,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
  });

  router.get("/api/mcp/oauth/authorize", async (req, res): Promise<void> => {
    if (!process.env["MCP_API_KEY"] || !currentFlowSecret()) {
      sendOAuthError(res, 503, "temporarily_unavailable", "MCP authorization is not configured.");
      return;
    }

    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    const responseType = typeof req.query.response_type === "string" ? req.query.response_type : "";
    const codeChallenge = typeof req.query.code_challenge === "string" ? req.query.code_challenge : undefined;
    const codeChallengeMethod = typeof req.query.code_challenge_method === "string"
      ? req.query.code_challenge_method
      : "";
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const requestedResource = typeof req.query.resource === "string" ? req.query.resource : undefined;
    const scope = hasAllowedScope(typeof req.query.scope === "string" ? req.query.scope : undefined);

    const clientRows = await db
      .select()
      .from(mcpOauthClientsTable)
      .where(eq(mcpOauthClientsTable.clientId, clientId))
      .limit(1);
    const client = clientRows[0];
    const registeredUris = Array.isArray(client?.redirectUris) ? client.redirectUris : [];
    const expectedResource = resourceUrl(req);
    if (!client || await isExpiredUnusedClient(client)) {
      sendOAuthError(res, 400, "invalid_client", "The OAuth client registration is expired or unavailable.");
      return;
    }

    if (
      responseType !== "code" ||
      !registeredUris.includes(redirectUri) ||
      codeChallengeMethod !== "S256" ||
      !isValidS256Challenge(codeChallenge) ||
      !scope ||
      (requestedResource !== undefined && requestedResource !== expectedResource)
    ) {
      if (registeredUris.includes(redirectUri)) {
        redirectWithError(res, redirectUri, "invalid_request", state);
      } else {
        sendOAuthError(res, 400, "invalid_request", "The authorization request is invalid.");
      }
      return;
    }

    const signedRequest = signedAuthorizationRequest({
      clientId,
      redirectUri,
      codeChallenge,
      state,
      scope,
      resource: expectedResource,
      expiresAt: Date.now() + AUTHORIZATION_COOKIE_MAX_AGE_MS,
    });
    if (!signedRequest) {
      sendOAuthError(res, 503, "temporarily_unavailable", "MCP authorization is not configured.");
      return;
    }

    setAuthorizationCookie(req, res, signedRequest);
    renderAuthorizationPage(res, {
      clientName: client.clientName || "This MCP client",
    });
  });

  router.post("/api/mcp/oauth/authorize", async (req, res): Promise<void> => {
    const request = readSignedAuthorizationRequest(cookieValue(req, AUTHORIZATION_COOKIE));
    if (!request) {
      sendOAuthError(res, 400, "invalid_request", "The authorization request has expired. Start again from Claude.");
      return;
    }

    if (req.body?.decision === "deny") {
      clearAuthorizationCookie(req, res);
      redirectWithError(res, request.redirectUri, "access_denied", request.state);
      return;
    }

    const submittedKey = typeof req.body?.mcpApiKey === "string" ? req.body.mcpApiKey : "";
    if (!matchesMcpApiKey(submittedKey)) {
      renderAuthorizationPage(res.status(401), {
        clientName: "This MCP client",
        error: "That MCP API key was not accepted.",
      });
      return;
    }

    const clientRows = await db
      .select()
      .from(mcpOauthClientsTable)
      .where(eq(mcpOauthClientsTable.clientId, request.clientId))
      .limit(1);
    const client = clientRows[0];
    if (
      !client ||
      await isExpiredUnusedClient(client) ||
      !client.redirectUris.includes(request.redirectUri)
    ) {
      clearAuthorizationCookie(req, res);
      sendOAuthError(res, 400, "invalid_client", "This MCP client is no longer registered.");
      return;
    }

    const authorizationCode = randomToken("mcp_code_");
    await db.insert(mcpOauthAuthorizationCodesTable).values({
      codeHash: digest(authorizationCode),
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      resource: request.resource,
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_LIFETIME_MS),
    });

    clearAuthorizationCookie(req, res);
    const target = new URL(request.redirectUri);
    target.searchParams.set("code", authorizationCode);
    if (request.state) target.searchParams.set("state", request.state);
    res.set("Cache-Control", "no-store").redirect(302, target.toString());
  });

  router.post("/api/mcp/oauth/token", async (req, res): Promise<void> => {
    const grantType = typeof req.body?.grant_type === "string" ? req.body.grant_type : "";
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
    const clientRows = await db
      .select()
      .from(mcpOauthClientsTable)
      .where(eq(mcpOauthClientsTable.clientId, clientId))
      .limit(1);
    const client = clientRows[0];
    if (!client || await isExpiredUnusedClient(client)) {
      sendOAuthError(res, 401, "invalid_client", "The OAuth client is not registered.");
      return;
    }

    if (grantType === "authorization_code") {
      const code = typeof req.body?.code === "string" ? req.body.code : "";
      const verifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier : "";
      const redirectUri = typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri : "";
      const codeRows = await db
        .select()
        .from(mcpOauthAuthorizationCodesTable)
        .where(eq(mcpOauthAuthorizationCodesTable.codeHash, digest(code)))
        .limit(1);
      const authorizationCode = codeRows[0];
      const now = new Date();

      if (
        !authorizationCode ||
        authorizationCode.clientId !== clientId ||
        authorizationCode.redirectUri !== redirectUri ||
        authorizationCode.usedAt ||
        authorizationCode.expiresAt <= now ||
        !verifier ||
        !verifyPkce(verifier, authorizationCode.codeChallenge)
      ) {
        sendOAuthError(res, 400, "invalid_grant", "The authorization code is invalid or expired.");
        return;
      }

      const consumed = await db
        .update(mcpOauthAuthorizationCodesTable)
        .set({ usedAt: now })
        .where(and(
          eq(mcpOauthAuthorizationCodesTable.codeHash, authorizationCode.codeHash),
          isNull(mcpOauthAuthorizationCodesTable.usedAt),
          gt(mcpOauthAuthorizationCodesTable.expiresAt, now),
        ))
        .returning({ codeHash: mcpOauthAuthorizationCodesTable.codeHash });
      if (!consumed[0]) {
        sendOAuthError(res, 400, "invalid_grant", "The authorization code has already been used.");
        return;
      }

      const tokens = await issueTokenPair(
        clientId,
        authorizationCode.resource,
        authorizationCode.scope,
      );
      res
        .set("Cache-Control", "no-store")
        .json({
          access_token: tokens.accessToken,
          token_type: "Bearer",
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
          scope: tokens.scope,
        });
      return;
    }

    if (grantType === "refresh_token") {
      const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : "";
      const tokenRows = await db
        .select()
        .from(mcpOauthTokensTable)
        .where(eq(mcpOauthTokensTable.tokenHash, digest(refreshToken)))
        .limit(1);
      const refreshTokenRow = tokenRows[0];
      const now = new Date();
      if (
        !refreshTokenRow ||
        refreshTokenRow.tokenType !== "refresh" ||
        refreshTokenRow.clientId !== clientId ||
        refreshTokenRow.revokedAt ||
        refreshTokenRow.expiresAt <= now
      ) {
        sendOAuthError(res, 400, "invalid_grant", "The refresh token is invalid or expired.");
        return;
      }

      const consumed = await db
        .update(mcpOauthTokensTable)
        .set({ revokedAt: now })
        .where(and(
          eq(mcpOauthTokensTable.tokenHash, refreshTokenRow.tokenHash),
          isNull(mcpOauthTokensTable.revokedAt),
          gt(mcpOauthTokensTable.expiresAt, now),
        ))
        .returning({ tokenHash: mcpOauthTokensTable.tokenHash });
      if (!consumed[0]) {
        sendOAuthError(res, 400, "invalid_grant", "The refresh token has already been used.");
        return;
      }

      const tokens = await issueTokenPair(
        clientId,
        refreshTokenRow.resource,
        refreshTokenRow.scope,
      );
      res
        .set("Cache-Control", "no-store")
        .json({
          access_token: tokens.accessToken,
          token_type: "Bearer",
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
          scope: tokens.scope,
        });
      return;
    }

    sendOAuthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  });

  router.post("/api/mcp/oauth/revoke", async (req, res): Promise<void> => {
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (clientId && token) {
      await db
        .update(mcpOauthTokensTable)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(mcpOauthTokensTable.clientId, clientId),
          eq(mcpOauthTokensTable.tokenHash, digest(token)),
          isNull(mcpOauthTokensTable.revokedAt),
        ));
    }
    res.status(200).set("Cache-Control", "no-store").send();
  });

  return router;
}