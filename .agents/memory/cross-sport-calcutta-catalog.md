---
name: Cross-sport Calcutta catalog
description: Product behavior for selecting Calcuttas outside the current NFL reporting model.
---

The global Calcutta selector must list every loaded Calcutta across sports. Existing Results, M2M, Trades, Auction Results, Teams, and Bidders views remain NFL-only.

**Why:** The user wants the full historical catalog visible now, but explicitly chose a clear unsupported-sport experience instead of expanding every report and data model to all sports.

**How to apply:** Preserve an NFL selection when resolving legacy year-only links. When a non-NFL Calcutta is selected on an NFL report route, do not issue NFL report requests for it; show the unsupported-sport state and leave catalog navigation usable.