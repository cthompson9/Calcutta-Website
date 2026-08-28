---
name: MCP endpoints
description: Authenticated MCP server at /api/mcp using OAuth; legacy GET shims were removed.
---

## Notes

- The legacy unauthenticated `/api/mcp/get_*` GET shims no longer exist.
- Use the authenticated MCP endpoint at `/api/mcp` and OAuth discovery endpoints
  instead; clients receive the server's declared tools after authentication.
- Privileged MCP tools rely on the authenticated transport context. Never add a
  reusable admin secret to a tool input schema or compare one inside a tool
  handler.

**Why:** Tool arguments pass through model and tool-call context; carrying a
commissioner credential there unnecessarily exposes a reusable secret.

**How to apply:** Keep mutation tools behind MCP transport authentication and
authorize from server-side identity/context only.

Dynamic OAuth registrations expire after 24 hours only while unused. A valid,
unrevoked authorization code or token keeps the client active through that
credential's own lifetime.

**Why:** Applying registration age unconditionally would invalidate advertised
30-day refresh tokens and force established MCP integrations to reauthorize
daily.

**How to apply:** Cleanup and client-resolution checks must use the same
"expired and no active credentials" rule; refresh tokens still enforce their
own expiry and one-time rotation.

MCP OAuth tokens and the general MCP transport key are read-only principals.
Commissioner mutations require the distinct admin key as the transport bearer;
the admin key never belongs in tool arguments. If both configured keys are
equal, MCP access remains read-only.

**Why:** Transport authentication alone does not authorize money, ownership, or
competition writes. Collapsing both keys into one principal creates broken
access control, while tool arguments expose reusable secrets to model context.

**How to apply:** Derive immutable authorization once per MCP request and gate
every mutating handler before database or network side effects. Add each new
mutation to the exhaustive ordinary-principal denial regression.
