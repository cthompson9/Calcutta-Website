# NFL refresh workflow

The production API runs on the single Reserved VM and owns the NFL refresh
poller. The poller starts with the API, checks at five-minute intervals, and
stops cleanly with the API process. It uses the persisted schedule cache,
game-window checks, and a database advisory lock, so restarts and overlapping
manual requests remain safe.

The poller only performs an actuals refresh when an NFL game is live or within
the configured post-kickoff window. It rechecks the schedule periodically so
postponements and kickoff changes are eventually observed. Outside an active
window it reuses the persisted schedule state and avoids expensive provider
requests.

The GitHub Actions workflow at `.github/workflows/refresh.yml` is retained for
manual recovery dispatches. It is not the production timer. A manual dispatch
calls:

```sh
POST /api/jobs/refresh
Authorization: Bearer <JOB_RUNNER_SECRET>
{"job":"standings","sport":"NFL","competition":"NFL_REGULAR_SEASON","force":true}
```

The endpoint remains protected by `JOB_RUNNER_SECRET` and uses the same
database-owned refresh lock as the in-process poller.

## MTM authority and recovery

There is one production MTM recalculation authority: the current
`runMtmPipeline` flow. The poller does not run a legacy Tuesday/canonical
writer.

- Replayed or unchanged actuals do not start a simulation.
- A single new final with complete, policy-valid conditional evidence may use
  lightweight reconciliation.
- Multiple new finals, corrections, incomplete source data, weak or missing
  conditional evidence, or a reconciliation warning create a durable pending
  recalculation state and trigger the full current pipeline.
- Full recalculations promote only after the existing validation and lease
  checks succeed.
- Failed or interrupted runs leave the prior coherent current mark in place
  and retain pending state for retry on a later poll or API restart.

Manual MTM recalculation suppresses intermediate actuals reconciliation and
performs one final validated promotion. Historical snapshots, valuation
versions, and publication safety rules are unchanged.