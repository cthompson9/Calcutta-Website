---
name: Auction results history
description: Historical display rules for the per-team auction results view.
---

Auction results must use the original winning owner and saved draft order from the auction, rather than current effective ownership after approved trades.

**Why:** A result is a historical record of how the auction concluded; showing a later buyer as the winner misstates the auction outcome.

**How to apply:** Use season-scoped primary auction ownership for winner labels, and sort result rows by the nullable saved draft order, placing unobserved orders after numbered nominations.