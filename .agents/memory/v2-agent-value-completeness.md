---
name: Calculated value authority
description: Authority and unavailable-value rules for calculated return fields across REST and MCP.
---

Stored Calcutta-entry economics are comparison-only audit observations, never
runtime inputs or fallbacks. Missing normalized realized or MTM coverage must
remain unavailable (`null`) in nullable contracts, and aggregations must
propagate that state rather than converting it to zero. A completely absent NFL
override uses the established adapter rubric; a partial override fails closed.
Sports without an approved default rubric remain unavailable until configured.
After a pool adopts the live MTM pipeline, the latest attempt is authoritative:
a failed attempt makes current Results unavailable even when an older successful
snapshot still exists, while an incomplete successful snapshot fails closed for
the entire pool.

**Why:** Legacy columns can contain historical values calculated under another
basis or untouched zero defaults. Falling back to them creates plausible but
false portfolio and consortium results and can suppress valid calculations.

**How to apply:** Use the same rule for owner portfolios, team/game values, and
consortium rollups across REST and MCP. Keep discrepancy reporting separate
from calculation, and preserve explicit availability/coverage indicators where
a legacy numeric response cannot represent null. Never mix pipeline values with
legacy calculated values inside one current response.