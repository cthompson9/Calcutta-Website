---
name: Consortium bridge rollout
description: Safe production rollout for moving legacy bidder consortium assignments to dated memberships.
---

Use an additive publish before moving legacy `bidders.consortium_id` values
into dated memberships. The old relation must remain available until the
production copy and validation are complete; never retire it through API
startup behavior.

**Why:** Production legacy IDs are the only link to the existing consortium
names. Removing the populated source before verifying the copy loses the
ability to reconstruct those names, especially for historical reports.

**How to apply:** Run the explicit protected migration after the bridge schema
exists, validate all source assignments, and only later remove the bridge.
During the transition, fall back to the legacy name only when a bidder has no
membership history at all; a dated assignment or clear is always authoritative.
Serialize bulk migration and commissioner membership writes with the same
per-bidder transaction locks.