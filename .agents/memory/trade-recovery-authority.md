---
name: Trade recovery authority
description: Source precedence and identity rules for restoring trades after the entry-model migration.
---

The pre-migration snapshot is authoritative through August 26, 2026 at 04:01. The current database is authoritative after migration. The August 23 recovery export is only a cross-check and must be contained in the pre-migration snapshot before it can independently justify restoration.

Reconcile trades by resolved entry, seller, buyer, percentage, and trade date, comparing multiplicity for repeated natural keys. Database IDs are not identities across the migration.

Historical workbook trades stay scoped to their original Calcutta. In particular, the Calcutta V Sam-to-Ed Jacksonville exchange cannot justify a Calcutta VIII, Calcutta XII, or generic 2026 Jacksonville trade.

Normalized historical position rows already represent the final source ownership state. Their normalized trade rows are a read-only audit ledger and must never be replayed into positions or costs.

**Why:** Entry and trade IDs were remapped during migration, while historical and live Calcuttas can contain the same NFL team with different ownership. Matching IDs or team names alone can silently restore the wrong economic event. Reapplying historical trades would double-count transfers that are already reflected in the final positions.

**How to apply:** Require the authoritative source before constructing a restore set. For live pools, validate trade existence and signed position legs separately, restore approved trades through the authenticated trade API, then assert every entry's ownership shares sum exactly to 1.000000. For normalized historical pools, reconcile and expose the ledger without mutating positions.