# 20 of 34 MCP tools reimplement a REST handler instead of calling it

_Audit finding P2-4._

Paste the block below to Replit as one task. Verify before moving on.

```
In artifacts/api-server/src/mcpServer.ts, 26 of 34 tools query the database inline,
duplicating logic that already exists in the REST route handlers. The 8 /v2 tools
(mcpServer.ts:353-472) already do it correctly: they import the service function from
routes/v2Agent and wrap the {status, body} result.

Refactor the legacy tools to the same pattern, starting with the ones that are line-for-line
duplicates and can silently diverge:
  - set_team_seed (:1544-1574)            vs PATCH /results/seed (results.ts:433-460)
  - compare_calcutta_returns (:1227-1256) vs GET /results/compare (results.ts:841-881)
  - set_team_period_snapshot (:1320-1435) vs POST /period-snapshots (periods.ts:500-640)
  - set_calcutta_payout_rules (:1468)     vs PUT /payout-rules

Extract each into a service function in lib/ or as an exported function from the route
module, and have both channels call it.

While doing set_team_period_snapshot, fix a live bug: mcpServer.ts:1375-1383 writes
marqueeWins: 0, marqueeTies: 0, marqueePtDiff: 0, ordinaryPtDiff: metrics.ptDiff, and the
tool schema offers no marquee inputs at all. The REST equivalent (periods.ts:531-548)
accepts marqueeWins/marqueeTies/marqueePtDiff and derives ordinaryPtDiff = ptDiff -
2*marqueePtDiff. Because playoff periods 19-22 must be entered by hand, this is the most
likely path to lose a marquee breakdown: a team at Week 18 with ordinary_pt_diff +40 and
marquee_pt_diff +45 re-entered via MCP silently loses 45 points. Add the marquee inputs and
use the same derivation as periods.ts.
```
