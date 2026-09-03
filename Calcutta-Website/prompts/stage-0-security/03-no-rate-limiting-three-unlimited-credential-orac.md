# No rate limiting, three unlimited credential oracles, and the admin key travels through LLM chat logs

_Audit finding P0-8._

Paste the block below to Replit as one task. Verify before moving on.

```
Add abuse protection and fix credential handling in this repo.

1. Install express-rate-limit. Apply a global limiter in artifacts/api-server/src/app.ts,
   plus a strict limiter (5 requests / 15 min / IP) on GET /api/admin/validate
   (routes/trades.ts:174), all of /api/mcp/oauth/*, and POST /api/jobs/refresh. These are
   three side-effect-free credential oracles; 300 guesses currently take 1.8 seconds with
   no lockout.

2. In artifacts/nfl-auction, stop persisting the admin key. Dashboard.tsx:112-113,153,157
   and MtmTracker.tsx:76-88 read/write sessionStorage["nfl_admin_key"]. Make it
   memory-only React state, matching what Trades.tsx:940 already does. Any XSS or malicious
   extension currently exfiltrates full ledger control.

3. Add maximum lengths to unbounded anonymous inputs: bidder/consortium names .max(120) and
   trade notes .max(2000) in lib/api-spec/openapi.yaml, then regenerate. 200 bidder rows
   can currently be inserted by an anonymous client in under a second.

4. Cap registered OAuth clients per IP and expire unused ones - POST /api/mcp/oauth/register
   is open by design (dynamic client registration) but currently unbounded.

Separately, and by hand rather than in code: rotate ADMIN_API_KEY, MCP_API_KEY and
JOB_RUNNER_SECRET to 32 random bytes each. All three have been reachable via an
unthrottled oracle, and ADMIN_API_KEY has been transiting LLM chat contexts because eight
MCP tools take it as a tool parameter (mcpServer.ts:530, 706, 823, 1114, 1318, 1477, 1532,
1594). Removing that parameter is part of the auth work, not this change.
```
