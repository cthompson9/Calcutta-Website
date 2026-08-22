---
name: Consortium identity
description: Naming and integrity rules for bidder consortium assignments.
---

Consortium names identify a shared global group, not free-form per-bidder labels. Treat trimmed names that differ only by capitalization or repeated internal whitespace as the same consortium.

**Why:** Owner cleanup data may be supplied with minor formatting differences. Splitting those variants would silently create duplicate groups and make reporting unreliable.

**How to apply:** Normalize names before assignment, reuse an existing case-insensitive match, and retain a database-level case-insensitive uniqueness guarantee for concurrent writes.