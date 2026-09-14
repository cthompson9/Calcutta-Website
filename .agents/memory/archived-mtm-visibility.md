---
name: Archived MTM visibility
description: Separates retained historical marks from current-mark publication authority.
---

Retained historical marks may remain visible as archived chart history when the
current valuation is unavailable. Exclude the current source snapshot whenever
the strict reader suppresses that current mark. The chart history includes only
promoted pipeline snapshots plus complete successful snapshots that predate the
versioning system. Legacy Week 0 rows may support baseline calculations but must
not appear as refreshes.

**Why:** Current-official standings and archived history have different
authority. Gating both on current availability hid intact prior snapshots, while
including the suppressed current point would bypass publication safety.

**How to apply:** Let history views consume retained promoted snapshots
independently of current team rows, but filter the current source snapshot until
the publication audit authorizes it. Do not prepend legacy MTM rows with capture
timestamps to pipeline refresh history. Admit pre-version successful runs only
before the first promoted version; newer unpromoted contenders remain excluded.