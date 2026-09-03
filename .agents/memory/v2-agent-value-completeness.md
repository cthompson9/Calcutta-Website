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
For immutable normalized historical imports only, a supplied owner total may
resolve a cent-rounding tie after calculated coverage is complete and the
absolute difference is no greater than one cent. It must not fill a missing
calculation or mask a larger discrepancy.
After a pool adopts the live MTM pipeline, the latest attempt is authoritative:
a failed attempt makes current Results unavailable even when an older successful
snapshot still exists, while an incomplete successful snapshot fails closed for
the entire pool.

**Why:** Legacy columns can contain historical values calculated under another
basis or untouched zero defaults. Falling back to them creates plausible but
false portfolio and consortium results and can suppress valid calculations.
Historical source workbooks can also retain more aggregate precision than entry
rows imported at cents; the narrow tie-break preserves the source's final penny
without surrendering calculated-value authority.

**How to apply:** Use the same rule for owner portfolios, team/game values, and
consortium rollups across REST and MCP. Keep discrepancy reporting separate
from calculation, and preserve explicit availability/coverage indicators where
a legacy numeric response cannot represent null. Never mix pipeline values with
legacy calculated values inside one current response.

Mixed-value MCP tools require an explicit `realized` or `mtm` basis. They must
not default an omitted basis to realized.

**Why:** A model can otherwise answer an MTM request with a plausible realized
`total_return`, even when the response also contains a separately named MTM
field.

**How to apply:** Describe both bases in the MCP server and tool schemas, reject
ambiguous calls without a basis, and keep dedicated realized-only and MTM-only
tools labeled as such.