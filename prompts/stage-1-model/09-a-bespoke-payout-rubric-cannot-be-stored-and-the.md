# A bespoke payout rubric cannot be stored, and the MCP tool that writes rubrics silently zeroes every return

_Audit finding P1-3._

Paste the block below to Replit as one task. Verify before moving on.

```
Three linked payout-rule problems in artifacts/api-server.

1. The MCP tool set_calcutta_payout_rules (mcpServer.ts:1466-1503) cannot write a valid NFL
   rule set: its metric enum omits "tie" so only 7 of the 8 required rules can be written,
   and playoffMultiplier defaults to 2 when NFL_SCORING_ADAPTER.validateRules only accepts
   1. It also performs no validation before its destructive delete-and-insert. Once invalid
   rules exist, rawRules.length > 0 disables the default-rubric fallback
   (calcuttaReturns.ts:1325-1331) and every team's calculated return becomes unavailable -
   /results renders realizedReturn 0 and netReturn -cost for all 32 teams. Fix: add "tie"
   to the enum, default playoffMultiplier to 1, and call the same validation that
   PUT /payout-rules already runs (routes/periods.ts:333-339) INSIDE the transaction before
   writing.

2. calculateNflTeamValues (lib/calcuttaReturns.ts:781, 806) hardcodes NFL_STARTING_POINTS
   and NFL_SCORING_ADAPTER.normalizationDenominator, discarding the adapter that
   configureAdapterForCalcutta built from calcutta_rules at line 1309. So a per-Calcutta
   starting_points or normalization_denominator override is validated, stored, loaded - and
   then ignored, while the generic allocator honours it. Pass the configured adapter's
   values through.

3. NFL_SCORING_ADAPTER.validateRules (lib/competitionScoring.ts:389-404) hard-rejects any
   rate other than Calcutta XII's (win 10, tie 5, pt_diff 1, playoff_berth 50, div_round
   100, conf_round 200, sb_berth 400, win_super_bowl 800) and any playoffMultiplier != 1.
   The business model is one bespoke rubric per Calcutta and there are 11 historical pools
   to load. Replace the hardcoded rate table with validation of SHAPE only - every required
   metric present exactly once, non-negative rates - and validate against the adapter
   configured for that Calcutta rather than the module constant. Keep Calcutta XII's rates
   as the default when no rules are stored.
```
