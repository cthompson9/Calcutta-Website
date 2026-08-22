---
name: New York timezone
description: Canonical timezone for pool dates, defaulted actions, and date displays.
---

Use `America/New_York` as the pool's canonical timezone whenever deriving a current calendar date or rendering a timestamp to users.

**Why:** UTC rollovers can assign trades and market snapshots to the following calendar day while it is still the prior day for pool participants.

**How to apply:** Preserve date-only database values as `YYYY-MM-DD`; derive omitted dates from the New York calendar and pass an explicit New York timezone to timestamp formatting. Do not use `toISOString().slice(0, 10)` for pool-facing defaults.