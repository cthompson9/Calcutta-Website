---
name: Startup migration validation
description: Validate previously applied development migrations before first-time production startup
---

Rule: When a startup migration was already recorded as applied in development, do not use a successful development server restart as proof that it will work on a fresh production schema. Execute the pending migration sequence in a development transaction that is intentionally rolled back, including its guarded SQL and follow-on statements.

**Why:** An invalid PostgreSQL procedural block was skipped on development startup because its version was already recorded there. Production reached it for the first time and the API crash-looped before serving any requests. The guard also contained minimum column counts that rejected the valid development schema once its syntax was fixed.

**How to apply:** Before publishing new startup migrations, verify first-run SQL against a schema with the expected existing tables; use a rollback transaction when replaying on development. Check the guard assumptions against actual columns as well as SQL syntax, and verify later migrations in order.