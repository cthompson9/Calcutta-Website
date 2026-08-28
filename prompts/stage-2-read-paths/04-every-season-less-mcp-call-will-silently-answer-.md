# Every season-less MCP call will silently answer about the oldest Calcutta

_Audit finding P1-5._

Paste the block below to Replit as one task. Verify before moving on.

```
In artifacts/api-server, the MCP surface resolves defaults and names unsafely.

1. defaultSeasonYear at mcpServer.ts:84-89 (and routes/mcp.ts:45-51 if that file still
   exists) calls resolveDefaultSeasonYearForSport without newestFirst, and
   lib/calcuttaContext.ts:88 orders ASC in that case - so it returns the OLDEST completed
   season, while ~20 tool descriptions and .agents/memory/mcp-endpoints.md all say "most
   recent completed season". routes/teams.ts:49, lib/cfbEventSync.ts:487 and
   lib/nflStandingsRefresh.ts:18 all correctly pass newestFirst: true. Fix the MCP callers
   to match, and remove the hardcoded `?? 2025` fallback in favour of an explicit error.
   This is invisible today with one season loaded and breaks the moment Calcuttas I-XI are
   loaded.

2. Replace every use of findTeam and findBidder (mcpServer.ts:98-114 - fuzzy
   ilike '%name%' limit 1, 17 call sites) with resolveUniqueName (mcpServer.ts:122-138),
   which does exact match, then unique partial, then errors on ambiguity. That is what
   docs/calcutta-v2-agent-playbook.md promises: "Ambiguous names produce an error rather
   than selecting an arbitrary match." Verified today: get_team_cost?team=s returns the
   Bills' price, and get_team_cost("New York") returns the Giants' or the Jets' depending
   on row order, with no ambiguity signal.

3. Also update .agents/memory/mcp-endpoints.md, which says "18 tools total" (there are 34)
   and documents the season default incorrectly.
```
