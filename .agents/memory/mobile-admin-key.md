---
name: Mobile admin key handling
description: How the Expo app stores the trade-approval admin key
---
The mobile app's admin key (bearer for PATCH /api/trades/:id/status) must never be persisted in AsyncStorage.
**Why:** completion review rejected plaintext persistence — AsyncStorage is unencrypted (localStorage on web), leaking an approval credential.
**How to apply:** native uses expo-secure-store (Keychain/Keystore); web is memory-only, re-entered after reload. See context/AppContext.tsx in artifacts/nfl-auction-mobile.
