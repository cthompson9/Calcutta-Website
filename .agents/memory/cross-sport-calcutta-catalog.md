---
name: Cross-sport Calcutta catalog
description: Product behavior for selecting Calcuttas outside the current NFL reporting model.
---

The global Calcutta selector must list every loaded Calcutta across sports. Results renders normalized historical reports for backloaded pools in any sport. Live MTM, Trades, Auction Results, Teams, and Bidders remain NFL-only.

**Why:** The normalized historical read model is sport-agnostic and is the authoritative source for older Calcuttas. Blocking non-NFL Results hid valid backloaded data, while the operational views still depend on the live NFL model.

**How to apply:** Preserve an NFL selection when resolving legacy year-only links. Let Results match older selections to normalized pools by name, year, and sport. On other non-NFL report routes, do not issue NFL requests; show the unsupported-sport state.