---
name: Schema design
description: Calcutta-entry boundaries for prices, ownership, trades, period returns, and MTM data.
---

## Calcutta ownership and price boundaries

Primary ownership and its cost basis belong to a Calcutta entry. Approved trades add signed entry positions; pending or rejected trades do not affect effective ownership.

Selected-pool auction economics come from the entry's primary position cost basis. Season-level auction rows are legacy compatibility data for canonical imports and standings, not the source for selected-Calcutta financial reads.

MTM marks and Week 0 captures are also keyed by Calcutta entry, so two pools containing the same team can retain different prices and valuations.

**Why:** Season/team keys are insufficient when multiple Calcuttas share an NFL season. They silently leak ownership costs, returns, or MTM writes between pools.

**How to apply:** Resolve the selected Calcutta first, then read or write through its entries. Omitted Calcutta IDs may resolve to the canonical NFL pool for legacy callers, but runtime financial data must never fall back across entries.
