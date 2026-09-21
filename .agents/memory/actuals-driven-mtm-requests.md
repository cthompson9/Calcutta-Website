---
name: Actuals-driven MTM requests
description: Durable rules for deciding when Actuals changes request and promote a new MTM valuation.
---

Hash canonical valuation-relevant Actuals content, not provider fetch timestamps, URLs, or other capture metadata. Persist the newest requested revision per pool, coalesce unchanged replays, and only mark a revision complete after a freshness-checked promotion.

**Why:** Provider re-fetches can change metadata without changing economics, while corrections can arrive during a long calculation. Treating either incorrectly can create needless runs or promote stale work.

**How to apply:** All automatic Actuals paths enqueue through the shared request service after committing Actuals. A running job must leave a newer revision pending, lock contention remains queued, and manual recalculation stays forced through the same orchestration.