---
name: Ownership write integrity
description: Concurrency and precision rules for auction primary ownership and trade lifecycle writes.
---

All writes that can change effective ownership for a season must share the same
per-season transaction advisory lock: AuctionPro imports, direct primary-split
corrections, trade approvals, percentage edits, and trade deletions. Primary
ownership is stored at four decimal places, so validate the persisted basis-point
total as exactly 1.0000 rather than accepting a floating-point tolerance.

**Why:** An approval or trade edit that slips between a primary split's
preflight check and its write can create an effective ownership state that was
never validated. Rounding accepted fractional shares independently can likewise
persist a total other than 100%.

**How to apply:** When adding a new ownership-affecting write path, take the
season lock inside its database transaction, reload affected rows after locking,
and validate before commit. Keep approved trades immutable; use an explicit
correcting trade rather than editing or deleting history.