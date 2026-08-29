---
name: Dated consortium reporting
description: Rules for keeping consortium changes from rewriting historical Calcutta reports.
---

Historical Calcutta reporting must resolve consortium membership at the canonical Calcutta’s deterministic as-of date (normally August 1 of that season). For normalized editions, roster selection must use an explicit persisted normalized-to-legacy Calcutta link, never infer identity from shared year and sport. A current-roster reading is available only when deliberately selected.

**Why:** bidders can move between consortiums, and multiple pools can eventually share a year and sport. Current affiliation or attribute-based pool matching can silently rewrite the past or leak a historical roster into a live pool.

**How to apply:** any new report, export, API, or MCP tool that shows consortium totals must default to the Calcutta as-of membership join and label a current-membership alternative clearly. Require an explicit pool link before using a normalized historical roster; otherwise use the legacy pool’s own dated membership. Keep membership intervals non-overlapping for each bidder.