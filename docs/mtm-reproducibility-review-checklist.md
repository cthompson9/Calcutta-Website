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