---
name: Live mark week boundaries
description: How successful pipeline captures become weekly points in the Live Tracker.
---

Derive a pipeline capture's displayed mark week from its stored remaining NFL schedule. A capture belongs to Week 0 while any Week 1 game remains, Week 1 while Week 2 is the earliest remaining week, and so on. Keep only the latest successful capture for each mark week.

**Why:** Numbering successful captures sequentially turns preseason recalculations and same-week retries into fake future weeks.

**How to apply:** Use the minimum remaining schedule week minus one, bounded at zero. Missing schedule state fails closed to Week 0 rather than inventing a later week.