---
name: Scheduled deployment separation
description: Replit currently does not allow Autoscale and Scheduled Deployments in the same project.
---

The NFL standings refresh must be hosted in a separate scheduled-deployment project; changing the existing NFL Auction app's deployment type would take the live website offline.

**Why:** Replit's current Publishing model permits one deployment type per project, so the existing Autoscale website cannot also own the scheduled worker.

**How to apply:** Keep the web app Autoscale. Put the refresh command in a separate project with the same database and required production secrets, then configure the Eastern-Time schedules there.