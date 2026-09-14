---
name: Archived MTM visibility
description: Separates retained historical marks from current-mark publication authority.
---

Retained historical marks may remain visible as archived chart history and as
display-only team/owner values when the current valuation is unavailable.
Archived numeric fallback is limited to complete, pool-reconciled snapshots from
official current/superseded versions; it must preserve `available: false` and a
stale reason. Exclude a current source snapshot only when no archived rows are
being exposed for it. Chart history includes promoted pipeline snapshots plus
complete successful snapshots that predate versioning. Legacy Week 0 rows may
support baseline calculations but must not appear as refreshes.

**Why:** Current-official standings and archived history have different
authority. Gating both on current availability hid intact prior snapshots, while
including the suppressed current point would bypass publication safety.

**How to apply:** Let history and standings consume retained official promoted
snapshots independently of current publication authority. Never relabel an
archived fallback current or available. Require exact entry coverage and pool
reconciliation. Do not prepend legacy MTM rows with capture timestamps to
pipeline refresh history. Admit pre-version successful runs only before the
first promoted version; newer unpromoted contenders remain excluded.