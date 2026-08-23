---
name: Expo Web source navigation
description: Reliable deep-link reveal behavior for long Expo Router lists on web and native.
---

Source links to a record in a long Expo Web list should reveal the rendered row with the browser’s element-scrolling behavior; native builds should use measured `ScrollView` coordinates.

**Why:** React Native `onLayout` coordinates from a row nested in a table or list are local to that container, while Expo Web renders nested browser scroll surfaces. Treating those local coordinates as a `ScrollView` content offset can leave a correctly highlighted record out of view after a cross-season route transition.

**How to apply:** For a web-only source reveal, wait until the row exists in the DOM and scroll that row into view. Keep a measured-offset fallback for native, and clear/rebuild measurements when a route switches between same-sized data sets.

When a source link selects a season, defer applying that URL season until the app’s stored-preference hydration has completed.

**Why:** asynchronous storage hydration can overwrite an early route-driven state change; marking the source season as already applied then leaves the user on the wrong season with no highlight.

**How to apply:** Gate the one-time source-season sync on the provider’s hydration flag, then perform the record reveal after the selected-season query and layout settle.