---
name: Reserved VM refresh scheduling
description: The single Reserved VM API process owns game-window refresh polling and durable MTM recovery.
---

The NFL standings refresh is driven by a five-minute in-process poller on the single Reserved VM API. GitHub Actions remains a manual recovery dispatch, not the production timer.

**Why:** GitHub's nominal five-minute cron actually ran only every two to five hours, while full MTM recalculations require the Reserved VM's guaranteed CPU and restart-safe database leases.

Use the 4 dedicated vCPU / 16 GB RAM Reserved VM configuration for production.

**Why:** The commissioner selected additional dedicated CPU capacity for the Python MTM workload rather than the smallest Reserved VM size.

Tuesday MTM ticks select the highest NFL `sport_periods` sequence with complete realized coverage across all 32 canonical entries. They do not infer the period from wall-clock week arithmetic. Canonical marks are keyed per period, with period 0 retaining the protected Week 0 key.

**Why:** Regular-season and postseason intervals are not uniformly seven days, while completed realized coverage is the authoritative signal that a period is ready to mark. Stable period keys make duplicate external ticks and partial retries safe.

**How to apply:** Keep one Reserved VM deployment. Start and stop the poller with the API lifecycle, persist refresh state, use database advisory/MTM lease locks, and keep the authorized job endpoint only for manual recovery.