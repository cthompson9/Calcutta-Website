# MTM reproducibility implementation/review checklist

This checklist is deliberately conservative. A **unit-tested** row means that
the named committed fixture test passed; it does not establish database,
provider, backtest, or production behavior. **Integration pending** means that
the corresponding database/API contract has not been exercised here.
**Shadow/backtest pending** means that no historical replay or side-by-side
run has been approved or performed. **Private provenance blocked** means that
the required source material is unavailable and must not be reconstructed from
private evidence. The fixture set is synthetic and does not preserve
production source bytes, ownership, or private evidence.

No source-regex test is used as runtime evidence. Nothing in this checklist
authorizes production activation; production use of this fixture set is
forbidden.

## Acceptance tests

| ID | Acceptance test | Status | Evidence/review note |
| --- | --- | --- | --- |
| A01 | Only sanitized synthetic fixture data is committed | Partial — fixture scope only | The fixture declares `synthetic: true`; this test does not certify every repository file. |
| A02 | Private/unredacted fixture paths are ignored | Rule present; validation pending | `.gitignore` covers the documented `private/**` fixture paths; no private file is committed. |
| A03 | Fixture README states the non-production boundary | Documented | README prohibits captures, ownership, and attached evidence; this is documentation, not runtime evidence. |
| A04 | Missing historical SHA/source bytes are explicit | Unit-tested | Fixture and manifest use `null`; the test rejects the placeholder hash. |
| A05 | Manifest hash matches committed fixture bytes | Unit-tested | Focused test computes SHA-256 and byte length from the file. |
| A06 | PHI 1/97 is retained as weak/missing evidence, not a midpoint | Unit-tested | Focused test exercises the quote-derivation contract; no historical quote is claimed. |
| A07 | HOU spillover sensitivity is diagnostic-only | Partial — fixture assertion only | The synthetic metadata has no target assertion; runtime sensitivity and any target remain shadow/backtest pending. |
| A08 | Active zero bid remains a quote | Unit-tested | Focused quote-semantics test. |
| A09 | One-sided quote bounds are explicit | Unit-tested | Bid-only and ask-only bounds are asserted. |
| A10 | Settled zero is distinct from active zero | Unit-tested | Settled evidence is asserted excluded and not `activeZeroBid`. |
| A11 | Duplicate trade IDs select one deterministic observation | Unit-tested | Focused trade-estimation test asserts newest observation and removal count. |
| A12 | Duplicate refresh IDs are visible in deterministic diagnostics | Partial — unit visibility only | The fixture test preserves duplicate IDs in diagnostics; refresh persistence/selection is integration pending. |
| A13 | Reversing source order preserves the trade estimate | Unit-tested | Existing evidence unit test covers order-independent trade estimation; it is not a database test. |
| A14 | Reversing source order preserves refresh selection | Integration pending | Requires a refresh persistence/selection contract test. |
| A15 | Quote provenance includes source URL and fetch timestamp | Integration pending | Requires a source-capture persistence contract; fixture metadata alone is insufficient. |
| A16 | Provenance hash changes when fixture bytes change | Partial — equality only | Hash equality is tested; mutation/rejection behavior is not implemented. |
| A17 | Historical source bytes can be independently reproduced | Private provenance blocked | Historical source bytes and SHA are unavailable and intentionally not copied. |
| A18 | Ownership/PHI is absent from committed fixtures | Review pending | No ownership fields are used in the synthetic fixture, but a human/private-data review is still required. |
| A19 | Focused fixture tests run without a database or network | Unit-tested | The focused command passed without starting the API, opening a database, or fetching a provider. |
| A20 | No pipeline, schema, API, UI, or solver implementation is changed | Not satisfied in current worktree | The fixture patch did not edit those areas, but the current worktree contains runtime/schema/solver changes; this row cannot be marked complete. |

## Six milestones

| Milestone | Deliverable | Status | Exit evidence |
| --- | --- | --- | --- |
| M1 | Define the synthetic-only fixture boundary | Partial — documented/rule scope | Fixture README, manifest policy, and private ignore rules are present; repository-wide data review and ignore-rule validation remain separate. |
| M2 | Capture the legacy normalization incident shape | Partial — fixture only | PHI 1/97 and HOU diagnostic metadata are synthetic; shadow/backtest confirmation is pending. |
| M3 | Lock quote and duplicate-ID semantics | Partial — unit scope | Quote and trade behavior is unit-tested; refresh persistence and selection are integration pending. |
| M4 | Verify provenance and hash reproducibility | Partial / private provenance blocked | Exact committed-file hash is checked; mutation, external provenance, and historical source bytes are unavailable. |
| M5 | Review private-data and ownership boundaries | Review pending | Automated metadata is present; human review is required and private evidence must remain out of scope. |
| M6 | Integrate the complete 20-test acceptance suite | Not implemented | Remaining integration and shadow/backtest rows require separate implementation; production activation is forbidden. |

## Focused review command

From the repository root:

```sh
pnpm --filter @workspace/api-server exec tsx --test src/lib/reproducibilityFixtures.test.mjs
```

This command is intentionally scoped to the fixture/unit contract; it does not
start the API, access a database, fetch provider data, run a shadow/backtest,
or authorize production activation. Integration and shadow/backtest evidence
remain pending.

## Controlled activation package

Package policy version: `mtm-v3-controlled-activation-v1`

Package status as of 2026-09-14: **HOLD — do not enable the review model.**

This is a separate activation decision, not an inference from a successful
review run. The configured `review_activation.enabled` value remains `false`.
No canonical selection, production pointer, method-version exclusion, or
publication transaction is changed by this package.


### Before/after payout bridge

The bridge must compare the last official model and reviewed model from the
**same immutable input state**, pool, completed-game set, market capture, seed
policy, and payout denominator. Private input state must not be committed.

| Measure | Required output |
| --- | --- |
| Pool conservation | Legacy total, review total, configured pool, and each absolute error |
| Team payouts | Team, legacy gross payout, review gross payout, dollar delta, and percentage delta |
| Owner payouts | Owner/consortium aggregate under both models and dollar delta |
| Ranking movement | Legacy rank, review rank, and rank delta for every team |
| Tail changes | Largest positive and negative team and owner deltas |
| Conditionals | Comparable good-quality cells, absolute deltas, mean delta, and p95 delta |
| Reconciliation | Every team/entry appears exactly once and totals bridge back to the pool |

No before/after numbers are asserted here because a same-state legacy/review
artifact is unavailable. Existing benchmarks compare canonical path counts
and a canonical NumPy optimization; they are not a v3 payout bridge.


### Migration and backward compatibility

- Review snapshots retain method version `mtm-v3-review`, remain
  noncanonical, and are excluded from canonical-period and latest-official
  selectors.
- Existing official snapshots, valuations, conditionals, and current
  production pointers remain authoritative and require no data rewrite.
- The activation policy is additive configuration. Older snapshots do not
  need the policy field; new review attempts copy its version, decision, and
  enabled state into diagnostics.
- Consumers may continue to read the existing valuation contract. Activation
  must not change response fields or reinterpret historical marks.
- A later activation must publish a newly validated official snapshot rather
  than relabel a stored review attempt.


### Configured policy

`mtm/season-config-2026.json` is the source of activation state:

```json
{
  "policy_version": "mtm-v3-controlled-activation-v1",
  "enabled": false,
  "decision": "hold",
  "requires_explicit_approval": true,
  "approved_replay_evidence": null,
  "approved_shadow_evidence": null,
  "approved_payout_bridge": null
}
```

Null evidence references are intentional blockers. Review diagnostics expose
this policy, but production selectors continue to exclude `mtm-v3-review`
independently of the flag. The flag is not wired as an automatic publication
switch.


### Decision record

| Required approval | Evidence available | Decision |
| --- | --- | --- |
| Historical replay thresholds approved | No approved replay artifact is referenced by the configured policy. | Blocking |
| Side-by-side shadow thresholds approved | No approved shadow artifact is referenced by the configured policy. | Blocking |
| Before/after payout bridge approved | No same-state legacy/review payout bridge is available for review. | Blocking |
| Runtime fits the production service class | Measured. The complete 20,000-path v3 review reached its quality decision in 404.148 wall seconds on the intended 4-CPU/8-GiB Reserved VM class, leaving 495.852 seconds (55.1%) inside the 900-second API worker limit. | Capacity passed; activation remains blocked by review quality and the other evidence rows |
| Explicit enable decision | **HOLD** | Review model remains disabled |

The decision may change to **ENABLE** only in a separate, approved change that
names the immutable replay, shadow, payout-bridge, and production-runtime
artifacts; changes `review_activation.decision`; and changes
`review_activation.enabled`. A passing engine gate alone is insufficient.


### Rollback instructions

If a separately approved activation later causes unacceptable behavior:

1. Stop new commissioner recalculations; do not delete snapshots or evidence.
2. Restore `review_activation.enabled` to `false` and its decision to `hold`.
3. Restore the prior publication code/pointer selection in a reviewed change;
   do not mutate or relabel the v3 snapshot as legacy.
4. Select the last validated pre-activation official version for each affected
   pool/period using the normal canonical selection transaction.
5. Verify team and owner totals reconcile exactly to the auction pool and the
   displayed version identity is the restored official version.
6. Preserve failed and superseded attempts for audit, record the reason and
   affected periods, and run a fresh shadow comparison before reconsidering
   activation.

For the current package, rollback is unnecessary because no production
pointer or publication path has moved.

### Resource measurements

Committed benchmark evidence currently establishes:

- Canonical 40,000-path benchmark: 55.525 CPU seconds and 135.6 MiB peak RSS;
  it was the smallest tested count meeting declared stability thresholds
  against 100,000 paths.
- Same-state optimized canonical NumPy run: 23.123 wall seconds, 22.828 CPU
  seconds, and 130.277 MiB peak RSS, compared with 68.843 wall seconds,
  68.715 CPU seconds, and 114.898 MiB peak RSS before optimization.
- Numerical equivalence was within `3.01e-12` for conditional output and
  exactly zero for valuations.

Sources: `mtm/engine/benchmark-2026-09-13.json` and
`mtm/engine/benchmark-numpy-2026-09-13.json`.

These figures do **not** approve v3 activation.

The complete v3 capacity run is recorded in
`mtm/engine/v3-production-capacity-2026-09-14.json`. It exercised 20,000 paths
on the intended 4-CPU/8-GiB Reserved VM class and reached the final review
gates in 404.148 wall seconds, leaving 495.852 seconds (55.1%) inside the
900-second API worker limit. Peak RSS was 3.230 GiB, leaving 4.770 GiB (59.6%)
of the cgroup memory limit. The review subprocess now uses that same worker
limit rather than an inconsistent five-minute limit.

Capacity passed, but the measured attempt was **not review-ready**: joint-fit
effective sample size was 102.331 against the 1,000 minimum, maximum weight was
0.027961 against the 0.01 ceiling, and the solver ended with
`interval_residual`. The activation decision therefore remains **HOLD**. No
canonical selector, production pointer, or publication transaction changed.
