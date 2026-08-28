# A historical pool reports every owner a 100% loss, formatted identically to a real result

_Audit finding P1-1._

Paste the block below to Replit as one task. Verify before moving on.

```
Before any historical Calcutta is loaded, fix the two ways a pool without snapshot coverage
reports fabricated financials as if they were real.

1. In artifacts/api-server/src/routes/results.ts:135-156, legacyDisplay spreads the legacy
   team_results row and then overwrites realizedReturn: 0, realizedMultiple: 0,
   netReturn: -cost, netPctReturn: -1, markToMarket: 0. The comment says the gap is
   "represented explicitly by the surrounding coverage flags", but no such flag exists in
   either response contract. Per .agents/memory/period-return-model.md, legacy result
   values should be used AS THE FALLBACK until the Calcutta has payout rules configured.
   Either surface team_results.realized_return, or return null for every financial field -
   never 0.

2. Add required snapshotAvailable (boolean) and rulesConfigured (boolean) fields to
   GetResultsResponseItem and GetResultsByOwnerResponseItem in lib/api-spec/openapi.yaml,
   regenerate, and make artifacts/nfl-auction render an explicit "no calculated coverage"
   state instead of dashes or zeros. Use `number` not `integer` for any new numeric field
   (see .agents/memory/openapi-numeric-fields.md).

3. In lib/calcuttaReturns.ts:1179-1183, restrict the adapter.defaultRules fallback to
   periodSequence === 0 exactly, as .agents/memory/period-return-model.md specifies. Today
   it applies at any period, so hasConfiguredPayoutRulesForCalcutta returns true for a pool
   with an empty payout_rules table and the whole season is valued off the Week 0 rubric.

4. Gate ensureWeekZeroReportingBaseline (results.ts:491, :818) so it does not auto-create a
   Week 0 baseline for a completed historical Calcutta - or exclude a Week-0-only ledger
   from being reported as the latest realized period.

Verify with a fixture: a 2015 Calcutta with 32 complete team_results rows and no
payout_rules or period snapshots must NOT report 0-0-0 records with a positive
realizedReturn, and must NOT report -100% net for every owner.
```
