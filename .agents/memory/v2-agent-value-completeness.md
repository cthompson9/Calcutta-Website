---
name: V2 agent value completeness
description: Rules for legacy financial fallback and unavailable values in the V2 REST and MCP read contracts.
---

When a Calcutta has a valid configured NFL payout rubric, missing normalized
realized or MTM coverage must remain unavailable (`null`). Legacy entry
economics are a compatibility fallback only when no valid rubric is configured.
Aggregations must propagate unavailable values rather than converting them to
zero.

**Why:** A configured rubric means normalized Phase 6 calculations are the
authoritative source. Falling back per team or treating missing values as zero
creates plausible but false portfolio and consortium results.

**How to apply:** Use the same rule for owner portfolios, team/game values, and
consortium rollups across both REST and MCP. Keep `calculation_status` and
nullable fields explicit so agents can distinguish missing coverage from zero.