---
name: ESPN NFL scoreboard contract
description: Supported ESPN query shape and calendar-boundary merge required for a complete NFL regular-season ledger.
---

Use the `site.web.api.espn.com` site API with `dates=<season>`, `seasontype=2`, and `limit=1000`, then merge explicit Week 17 and Week 18 requests by event ID.

**Why:** Date-range queries return HTTP 400, the old `site.api.espn.com` host may deny access, and a calendar-year season query omits January games from Weeks 17–18.

**How to apply:** Validate the merged payload contains exactly 272 target-season regular-season games spanning Weeks 1–18 before any database write, and retain bounded provider response text for failures.