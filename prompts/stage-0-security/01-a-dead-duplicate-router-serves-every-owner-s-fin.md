# A dead duplicate router serves every owner's financials with no credential

_Audit finding P0-3._

Paste the block below to Replit as one task. Verify before moving on.

```
Delete artifacts/api-server/src/routes/mcp.ts entirely, along with its import and the
router.use(mcpRouter) line in artifacts/api-server/src/routes/index.ts (lines 11 and 29).

Why: app.ts:36-41 mounts the MCP_API_KEY-gated router at /api/mcp, but that router only
registers the exact path "/". A GET to /api/mcp/get_owner_cost therefore falls through to
the general /api router and hits routes/mcp.ts, which has no authentication. All 15
get_* shims currently return owner cost, return and mark-to-market figures to anonymous
callers, and a `%` wildcard as the owner name matches the first row.

This router is dead code: nothing in artifacts/nfl-auction references it, it is absent from
lib/api-spec/openapi.yaml, and the mcpServer.ts tools already cover every one of these
reads through the authenticated POST /api/mcp endpoint. It has also already diverged from
mcpServer.ts (returns 0 where the real tools return null).

Also update .agents/memory/mcp-endpoints.md, which documents these 15 GET endpoints as a
live surface, to say they were removed in favour of the authenticated MCP tools.

After deleting, confirm that GET /api/mcp/get_owner_cost returns 404 and that
POST /api/mcp with a valid bearer token still lists tools normally.
```
