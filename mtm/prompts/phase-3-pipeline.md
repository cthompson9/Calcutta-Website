# Phase 3 — Scheduled pipeline + persistence

Paste to the Replit agent:

---

Wire the weekly run. The chain is: export state → fetch quotes → run
`mtm/engine/run_mtm.py` → persist snapshot. One entrypoint for the whole
chain — `mtm/run.ts` — so the cron and the future admin button share a code
path. Do not modify `mtm/engine/` Python.

**1. Persist step.** `mtm/persist-snapshot.ts`: reads `snapshot.json`, writes
`mtm_team_projection` and `mtm_entry_valuation` rows, updates the
`mtm_snapshot` row status. On `status: failed`, write the failed row with the
error and stop — never write partial projections. Make persistence idempotent
on (pool_id, as_of hour): a retried run updates rather than duplicates.

**2. Workflow.** Extend `.github/workflows/refresh.yml`'s existing `mtm` job
option:

- Schedule: add `0 7,8 * * 2` (two UTC candidates for 3am ET across DST).
- First step gates: proceed only if `TZ=America/New_York date +%H` is `03`
  (or the trigger is `workflow_dispatch` with job=mtm). Exactly one snapshot
  per Tuesday.
- Steps: checkout → node (export + fetch) → python 3.11 + `pip install
  requests` → `run_mtm.py` → node persist. Secrets: DB connection only —
  Kalshi's public endpoints need no auth.
- Timeout 10 minutes; on any step failure, still write the `failed` snapshot
  row (wrap in the persist step's failure path).

**3. Serving.** The API serves "current mark" = latest `ok` snapshot for the
pool. Add `stale: true` to the response when that snapshot is older than the
config's `stale_after_hours` (168). No UI work yet — Phase 4.

Acceptance: (a) a manual `workflow_dispatch` mtm run produces exactly one
complete snapshot; (b) the doubled cron produces one snapshot on Tuesday, not
two; (c) killing network to Kalshi mid-run yields a `failed` row, zero
projection rows for that snapshot, and the API still serves the prior mark
with `stale` computed correctly.

---
