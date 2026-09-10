---
name: Deep-link query parsing
description: Reliable query parameter handling for Results source links in the web app.
---

For Results source backlinks, treat the browser URL as the canonical source of query parameters.

**Why:** Route location state can omit the query string, which prevents destination pages from finding and focusing the linked record.

**How to apply:** Parse deep-link targets from the canonical URL whenever a page needs to act on a source record.

When a source link opens an expandable destination, expand the matching disclosure once per target, then respect the user's subsequent collapse or expansion.

**Why:** Source navigation should reveal the destination without overriding a user's later disclosure choice.

**How to apply:** Reapply automatic expansion only after the source target changes or disappears.

Before navigating from a transient Results view to a source record, encode the originating tab and disclosure identity into the current history entry.

**Why:** Browser back or the Ctrl+[ shortcut remounts Results; component-only state resets to the default tab and loses the disclosure that launched the backlink.

**How to apply:** Replace the current Results URL with return-state parameters immediately before source navigation, restore them on mount, and clear them after deliberate tab changes.