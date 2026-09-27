---
name: Auction test reset scope
description: User-confirmed boundary for resetting an auction after practice runs
---

An admin reset of an unfinished test auction clears the run's bids, nominations, sales, sale-derived primary ownership, and listener transcripts. It must preserve the Calcutta itself, the roster, and its lots so another run can begin without rebuilding them. The reset must never silently undo completed history or approved trades; it must reject ownership that no longer matches its recorded sales. Keep an audit of the reset.

**Why:** The user explicitly chose “Auction run only (keep Calcutta, roster, and lots)” over deleting the whole draft Calcutta. A sale writes real ownership even during a test, so clearing only visible auction state would leave false results behind.

**How to apply:** Any future reset/delete controls for practice auctions or changes to sale persistence must respect this scope and provide an explicit typed confirmation.