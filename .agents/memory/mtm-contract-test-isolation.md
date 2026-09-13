---
name: MTM contract test isolation
description: Why tests that publish coherent MTM versions require a dedicated database.
---

Tests that promote coherent MTM valuation versions must run only against a dedicated disposable test database. They must skip rather than fall back to the shared development database.

**Why:** Promoted versions and their source evidence are intentionally append-only. A contract test that used the shared database left synthetic pools visible in the application after every run. A disposable-schema attempt also showed that the legacy migration chain is not currently reliable on a fresh schema.

**How to apply:** Any test that exercises real MTM promotion must require an explicit test-only database connection. Do not weaken publication guards or use the normal application database as a fallback.