---
name: MCP endpoints
description: 15 GET endpoints at /api/mcp/* for LLM tool use, returning { value } JSON.
---

## Team endpoints (query: ?team=Buffalo+Bills&season=2025)

- /mcp/get_team_owner1..5 — returns owner name by index
- /mcp/get_team_cost — bid amount (no season param needed)
- /mcp/get_team_points — starting points (from team_results)
- /mcp/get_team_return — realized_return
- /mcp/get_team_wins — wins
- /mcp/get_team_ptdiff — pt_diff
- /mcp/get_team_mtm — mark_to_market
- /mcp/get_team_draftorder — draft_order

## Owner endpoints (query: ?owner=Zachary+Long&season=2025)

- /mcp/get_owner_cost
- /mcp/get_owner_return
- /mcp/get_owner_mtm

## Notes

- All use fuzzy ILIKE matching on team/owner name
- All return `{ value: string | number | null }`
- `and` from drizzle-orm must be imported — missing it causes runtime ReferenceError
- If no season param, defaults to most recent completed season
