---
name: Canonical MTM schedule
description: Authority and uncertainty rules for the NFL schedule consumed by MTM.
---

After the complete-season NFL event refresh succeeds, canonical persisted events are the only remaining-schedule source for MTM. A kickoff is marquee only when its persisted time is confirmed; unknown times remain non-marquee until a later refresh confirms them.

**Why:** Re-fetching 18 weekly provider endpoints duplicated the validated event ledger, introduced avoidable timeout failures, and classified provider placeholder times as real marquee kickoffs.

**How to apply:** Keep one validated complete-season refresh before MTM export. Build engine schedule identity and provenance from canonical events, recomputing marquee from confirmed persisted kickoff timestamps on every export.