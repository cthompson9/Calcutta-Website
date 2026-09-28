# MLB postseason compatibility design

## Decision and boundary

Calcutta XIII should use the existing Calcutta entry, auction, signed-position/trade, event-evidence, snapshot, and official-publication primitives. Do **not** create a second MLB ownership ledger, MTM history, current-mark selector, or MCP service. The necessary additions are sport/competition-format adapters and narrowly scoped extensions where the current path is NFL-specific. This is a design plan, not an assertion that MLB actuals or MTM already run.

Two separate properties matter:

- **Sport** determines provider identity, legal game outcomes, available markets, and scoring rules.
- **Competition format** determines whether the planned fixture set is known (regular season, subject to revisions) or contingent on advancement (knockout postseason). Knockout stages may be best-of-1, 3, 5, or 7. The round rubric explicitly controls win points, sweep eligibility/bonus, and bye awards; a best-of-1 win is not implicitly a bonus-eligible sweep.

Keep NFL's existing behavior unchanged. Reuse the same public team-value and owner-economics output contract even when NFL and MLB calculate points differently.

## What is already present — do not rebuild

| Existing primitive | Current home | Compatibility rule |
| --- | --- | --- |
| Pool identity and entries, auction prices/sales, signed ownership and approved trades | `lib/db/src/schema/calcuttas.ts`, `calcuttaEntries.ts`, `auction.ts`, `positions.ts`; `artifacts/api-server/src/lib/ownerResultEconomics.ts` | Key all MLB reads/writes to the selected Calcutta and entry, never a season-only NFL fallback. |
| Provider-neutral event shape and raw evidence | `artifacts/api-server/src/lib/eventIngestion.ts` | Implement an MLB adapter; retain scoped provider IDs, status, scores, and raw payload. |
| Scoring-adapter interface, period/snapshot metrics, and rules validation | `artifacts/api-server/src/lib/competitionScoring.ts`, `calcuttaReturns.ts` | Extend adapter dispatch rather than copying a second return pipeline. |
| Postseason calendar topology, ordered rounds, series, games, candidates, and rubric-value storage | `lib/db/src/schema/calcuttaCalendar.ts` | Use the calendar to model contingent games and series; its rubric labels alone are not an executable scorer. |
| Per-simulation-path pot normalization | `mtm/engine/simulate.py` | Reuse its conservation principle, not its NFL season/advancement simulator. |
| MTM attempt evidence, validation, current-version promotion, and actuals-revision job protocol | `artifacts/api-server/src/lib/mtmPipeline.ts`, `currentMtm.ts`, `mtmActualsRecalculation.ts` | Keep one audit/promotion lifecycle. A simulation result is not an official mark until the existing gates pass. |

## Only the compatibility gaps to close

### 1. Represent knockout series of length one

`calendar_series.best_of` and its domain helper currently accept 3/5/7 only. Extend the check and validation to admit 1 without changing existing rows or NFL's single-elimination bracket. A bye is an advancement/award with evidence, **not** a fabricated winning game. The existing pool's `competitionFormat` and calendar format can select adapter capabilities; no new general season table or replacement bracket schema is required.

**Check:** best-of-1/3/5/7 all validate; a game after a series is decided is not counted; a bye advances and earns its configured points without a game.

### 2. Make one pool rubric authoritative for display, actuals, and simulation

Pool creation writes `calcutta_rules`, while calculated returns currently read `payout_rules`; the auction's MLB rubric is presently a hardcoded display, and calendar rubric values are descriptive. Bridge these existing stores at one validated pool-rubric read/translation boundary. For MLB, persist and read eight round-specific values (win and sweep for each of Wild Card, Division Series, LCS, World Series) plus the Wild Card bye award. Do not silently substitute the displayed values if stored rules are missing or incomplete. Preserve the established NFL payout-rule fallback and behavior; migrate neither NFL history nor financial data merely to share a UI.

**Check:** the auction, API/MCP rubric read, realized points, and simulation all resolve the same selected-pool values; incomplete or conflicting rules are visibly unavailable rather than guessed.

### 3. Add MLB game and series actuals through the shared event path

Extend sport/competition dispatch and the refresh job to an MLB postseason adapter. Map stable provider game IDs and teams into canonical events, associate each final with its calendar series and round, and derive winner, completed-series sweep, and earned bye exactly once. Revisions must hash the canonical inputs that can change points (scores, status, round/series association, bye/advancement), not fetch timestamps. Keep the existing durable coalesced recalculation, stale-mark, and correction behavior.

**Check:** repeated imports are idempotent; corrected results replace affected actuals and queue a new mark; unplayed contingent games are not reported as missing regular-season fixtures.

### 4. Support variable total points without changing NFL economics

Add an adapter-selected normalization policy to the common value calculation: MLB divides each team's nonnegative payable points by the **sum across the entire pool for that completed outcome or simulation path**, then allocates the sold pot with exact cent conservation. Reject a nonpositive total or incomplete entry coverage. NFL retains its approved fixed-denominator/normalization behavior and published mark semantics. Do not treat sweep bonus or bye points as fixed league-wide game inventory.

**Check:** 2-game and 3-game Wild Card outcomes produce their actual differing point totals but both allocate exactly the same sold pool; team values and signed owner returns reconcile to that pool.

### 5. Plug MLB into, rather than around, official MTM publication

The current official state builder, market validation, engine projections, and completeness checks assume NFL (including 32 entries, NFL weeks, win ladders, and NFL advancement fields). Keep the attempt/evidence/lease/promotion machinery, but supply an MLB state builder, legal best-of-series simulator, market interpretation, and sport-specific output/quality checks behind that lifecycle. Make shared completeness checks use the selected pool's entry set, while preserving sport-specific probability and coverage checks. Retain the existing failed/pending/current distinction and deterministic official promotion.

**Check:** a complete, audited MLB simulation can publish one pool-scoped mark; a partial book, missing entrant, bad probability, or stale actual revision cannot publish; NFL regression marks remain unchanged.

### 6. Use the existing pool-scoped API/MCP surface

Make relevant results, rubric, snapshot-status, valuation, and owner reads resolve an explicitly selected pool and competition. Reuse response/auth/current-source semantics; add only the fields needed to describe MLB round/series outcomes. Preserve the legacy season-only NFL default for old callers. The auction page should render the validated stored rubric instead of a disconnected copy. Do not expose MLB fair values as available before an official mark passes the shared publication gates.

**Check:** REST and MCP agree on the selected MLB pool's rubric, availability, entry values, and current snapshot; selecting NFL still returns the existing NFL behavior.

## Suggested implementation order and completion gate

1. Lock the pool-rubric contract and format capabilities; support best-of-1 and test unchanged NFL rules.
2. Add MLB event/series actuals and points, then variable-total realized payout using the shared entry/owner ledger.
3. Add MLB legal simulation and evidence/quality adapters to the existing MTM promotion path.
4. Wire pool-scoped REST/MCP and replace the auction's display-only rubric with the validated pool rubric.

Do not consider Calcutta XIII's results or MTM operational until those cross-sport checks pass. Creating or selling lots can use today's auction primitives independently; it must not imply that MLB scoring or fair values are already live.