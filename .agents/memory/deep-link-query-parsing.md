---
name: Deep-link query parsing
description: Reliable query parameter handling for Results source links in the web app.
---

For Results source backlinks, parse query parameters from the browser URL rather than relying only on Wouter's `useLocation()` value.

**Why:** In this app, navigation reached the correct path while `useLocation()` could omit its query string. Destination pages therefore did not detect source record IDs and failed to focus or highlight them.

**How to apply:** When a route's behavior depends on deep-link query parameters, use the router hook to react to route changes but read `window.location.href` (with a browser-safe fallback) when parsing the query.