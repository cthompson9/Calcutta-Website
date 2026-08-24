# NFL standings refresh schedule

The refresh command is:

```sh
pnpm --filter @workspace/api-server run refresh:nfl-standings
```

The live NFL Auction app is already published as an Autoscale deployment. Replit
does not allow an Autoscale app and Scheduled Deployments to coexist in the same
project, so do **not** use “Change deployment type” on the live app. That would
replace the website deployment.

Create a separate Replit project for this short-lived worker, with access to the
same database and required production secrets, and configure the worker to run
this exact command:

1. “Every day at 12:00 AM America/New_York”
2. “Every Sunday from 12:00 PM through 11:30 PM America/New_York, every 30 minutes”

Use the America/New_York wording in the scheduler so its schedule remains aligned
with Eastern Time across daylight-saving transitions. The command resolves the
active season, takes the same season advisory lock as an admin import, and exits
after a successful, replay-safe fetch. A source failure exits non-zero without
changing stored standings.