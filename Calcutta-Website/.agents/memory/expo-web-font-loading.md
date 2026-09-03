---
name: Expo Web font loading
description: Avoid an empty Expo Web root when preview-proxied font loading does not settle.
---

On Expo Web, the app must not return `null` solely because optional custom fonts have not loaded. The preview proxy can delay or prevent that font-loading promise from settling, leaving the browser with an empty root despite a healthy Metro bundle.

**Why:** Native splash behavior can safely wait for fonts, but the browser otherwise has no visible loading state and appears broken.

**How to apply:** Keep the native font/splash gate. On web, render the app shell immediately and let React Native Web use system fallbacks until custom font faces become available.