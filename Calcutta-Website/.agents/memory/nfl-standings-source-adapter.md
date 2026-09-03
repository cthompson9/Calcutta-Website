---
name: NFL standings source adapter
description: Durable parsing constraint for the nfl.com standings source.
---

NFL playoff and clinch letters can appear in `<sup>` markup inside the team's
club-name element, not only beside it. Team identity matching must remove those
marker tags before comparing to the canonical team name, while playoff status
parsing must still inspect the complete team cell.

**Why:** Treating the rendered marker as part of the name causes valid,
in-season standings imports to reject marked teams and prevents scheduled
refreshes exactly when playoff information becomes available.

**How to apply:** When changing the nfl.com parser or replacing the source
adapter, retain a fixture with embedded name markers and preserve separate
identity and status extraction paths.