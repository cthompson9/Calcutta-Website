---
name: ESPN MLB scoreboard discovery
description: MLB scoreboard request boundaries and explicit postseason filtering.
---

Use validated daily ESPN MLB scoreboard requests and inspect each event's season year and season type; do not trust a request's postseason filter or infer tournament completeness from a nonempty response.

**Why:** In direct source checks, both MLB scoreboard hosts rejected date-range requests with HTTP 400. A season request with `seasontype=3` returned preseason games, whereas daily requests returned usable structured postseason evidence.

**How to apply:** Bound discovery/backfill requests, persist the covered dates, and filter events explicitly before ingestion. Preserve prior evidence when a daily response is partial or empty. Postseason round/game labels and final scores must be validated, not inferred from the calendar date or series summary.
