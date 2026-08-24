# NFL standings refresh via GitHub Actions

The live NFL Auction app remains an Autoscale deployment. It receives a small
authenticated refresh request from GitHub Actions every five minutes, wakes only
for the request, and returns to idle afterwards. This replaces the earlier
separate-Replit-worker suggestion.

The checked-in workflow is `.github/workflows/refresh.yml`. Before enabling it
in GitHub, add these repository secrets:

- `CALCUTTA_APP_URL`: the published app's base URL, without a trailing slash
- `CALCUTTA_JOB_SECRET`: the same long random value stored as this app's
  `JOB_RUNNER_SECRET` Replit Secret

The endpoint is:

```sh
POST /api/jobs/refresh
Authorization: Bearer <JOB_RUNNER_SECRET>
{"job":"standings"}
```

The endpoint exits quickly while no NFL game is live or recently final, unless
the last successful standings refresh is older than 24 hours. It uses a
non-blocking PostgreSQL advisory lock, so overlapping external ticks return
`already-running` rather than queuing work.