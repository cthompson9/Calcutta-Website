# The client has no error state around any money figure, and derives on the client what the server owns

_Audit finding P2-7._

Paste the block below to Replit as one task. Verify before moving on.

```
In artifacts/nfl-auction, no page distinguishes a failed request from empty data.

1. Results.tsx, MtmTracker.tsx and Trades.tsx never read isError or error from any of their
   ~12 Orval query hooks, and pass rows={teamResults ?? []} (Results.tsx:332,343,353). A
   500 renders an empty leaderboard, identical to "no data yet". Destructure isError/error
   from every hook and render an explicit error state naming what failed and offering a
   retry. Never render a money figure derived from a failed query.

2. hooks/useSeason.ts:70 falls back to DEFAULT_YEAR = 2026 (line 18) when GET /calcuttas
   fails, so every money query then runs against a season the user never selected. Render an
   error instead of guessing a season.

3. Delete computeSeeds (Results.tsx:1711-1746). It reimplements NFL playoff seeding on the
   client while TeamResultRow.seed already exists and is written by PATCH /results/seed and
   the MCP set_team_seed tool, and the client version ignores the real division-winner
   tiebreakers. Use the server value.

4. Standardise money formatting. formatCurrency (lib/utils.ts:8-15) forces
   maximumFractionDigits: 0, so per-team rows visibly fail to sum to the displayed owner
   total, while adjacent cells use toLocaleString(), toFixed(1), toFixed(2),
   Math.round(x*100)/100 and Math.round(share*10_000)/100. Pick one currency formatter with
   cents and one percentage formatter, use them everywhere, and delete the dead
   formatPercentage export.

5. Type the ownership-write forms properly. Teams.tsx:269,312,325 (the primary-split editor,
   summing ownershipShare over (o: any)) and Trades.tsx:645-647,664,714,723,730 use `any`
   on the paths that change ownership. Use the generated types from @workspace/api-zod.

6. In artifacts/api-server/src/lib/calcuttaReturns.ts:765 and :798, the rules parameter
   defaults to `NFL_PAYOUT_RULES as unknown as RuleValue[]`, so a caller that omits rules
   silently scores against the hardcoded rubric instead of the Calcutta's configured one.
   Make the parameter required.
```
