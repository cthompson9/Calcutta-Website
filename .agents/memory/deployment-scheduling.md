---
name: External refresh scheduling
description: The Autoscale app uses an external GitHub Actions tick instead of a second Replit deployment.
---

The NFL standings refresh is request-driven: GitHub Actions calls the dedicated job endpoint every five minutes while the live NFL Auction app stays on Autoscale.

**Why:** Replit's Publishing model cannot co-host an Autoscale website and a Scheduled Deployment in one project. An external tick preserves the live app and lets Autoscale wake only when needed.

Tuesday MTM ticks select the highest NFL `sport_periods` sequence with complete realized coverage across all 32 canonical entries. They do not infer the period from wall-clock week arithmetic. Canonical marks are keyed per period, with period 0 retaining the protected Week 0 key.

**Why:** Regular-season and postseason intervals are not uniformly seven days, while completed realized coverage is the authoritative signal that a period is ready to mark. Stable period keys make duplicate external ticks and partial retries safe.

**How to apply:** Keep scheduling outside Replit. Preserve the dedicated job authorization and overlap protection; never substitute the commissioner key or reintroduce a second Replit deployment. Resolve scheduled MTM periods from complete realized coverage and reject same-date noncanonical collisions rather than overwriting manual marks.