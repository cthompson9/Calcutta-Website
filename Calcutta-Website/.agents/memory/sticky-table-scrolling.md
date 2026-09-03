---
name: Sticky table scrolling
description: Reliable header locking for wide, long report tables.
---

Long report tables should use a bounded native scroll container with a sticky header rather than relying on viewport-sticky headers inside a horizontal overflow wrapper.

**Why:** A horizontally scrollable ancestor becomes the sticky element's scroll container in browsers, so a header intended to follow page scrolling can disappear. A bounded table scroller preserves both vertical header locking and horizontal access on narrow screens.

**How to apply:** Use the shared table-scroll and sticky-table-header styles for each data table. Keep the application shell from becoming an accidental vertical scroll container when it only needs to suppress horizontal overflow.