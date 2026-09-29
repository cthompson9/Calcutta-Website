---
name: Consortium reporting grain
description: Distinguish the buyer shown in auction reports from the member-level sale ledger.
---

For Calcutta XIII auction displays, a consortium is one buyer per sold lot even when the sale ledger has multiple member allocations. Show its name once, sum its member shares and cost, and count the lot once in consortium reports. Keep member ownership and cost basis intact for audit and payouts.

**Why:** The user noticed a single buyer displayed as the same consortium name repeated for its two owners, while the By Consortium report counted owner allocations as separate lots. The consortium is the presentation and report grain; its members are the underlying economic grain.

**How to apply:** When a view labels a row or total "By Consortium," group allocations by auction consortium identity within each sale before rendering, counting lots, or totaling cost. Keep owner-level detail in administrative roster and accounting flows.