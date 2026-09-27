---
name: Consortium owner split history
description: Why an auction consortium's membership and split cannot be changed after its first recorded sale.
---

Keep recorded sale ownership and cost basis tied to the owners and shares in effect when the sale was finalized. Once a consortium has been used in a sale, its membership and owner percentages should not be silently changed through roster editing. Use the audited sale-correction path where ownership economics must change.

**Why:** A roster edit that implicitly redistributes previously recorded bidder positions would alter historical ownership and monetary basis without a correction record. Applying a new split only to future sales would also make the roster appear to explain past sales when it does not.

**How to apply:** Treat roster percentages as editable during setup and before the consortium's first sale; reject owner or share edits afterward, while allowing non-economic labels and active status changes under their existing guards. Preserve sale-level consortium attribution and owner-level allocations in snapshots so corrections can reconstruct the recorded sale.