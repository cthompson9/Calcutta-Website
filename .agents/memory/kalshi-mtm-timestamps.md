---
name: Kalshi MTM timestamps
description: Defines timestamp authority for Kalshi market evidence freshness.
---

Kalshi market `updated_time` describes non-trading market metadata and must not
be treated as the observation time of the current bid/ask book. A successful
live current-market response may use its response capture time as the book
observation time. Saved or replayed evidence retains its original capture
provenance; missing provenance stays missing. Validated settlements are facts,
not active prices subject to the short freshness window.

**Why:** Freshly downloaded books were repeatedly rejected because old metadata
timestamps were misinterpreted as stale price observations.

**How to apply:** Keep provider metadata-update time separate in audit records.
Pass explicit preflight and publication evaluation times to active-price
freshness checks so long calculations fail if their inputs expire. Do not apply
the active-price freshness gate to unused records or validated settlement facts.