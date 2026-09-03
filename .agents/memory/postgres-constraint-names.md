---
name: PostgreSQL constraint names
description: Avoid repeated Drizzle schema drift caused by PostgreSQL identifier truncation.
---

Give Drizzle foreign keys explicit, stable names shorter than PostgreSQL's identifier limit whenever the generated name would be long.

**Why:** PostgreSQL truncates identifiers to 63 bytes. Drizzle can then compare the truncated live name with its longer generated name and propose dropping and recreating the same foreign key on every schema push, including immediately after a successful push.

**How to apply:** For long table and column combinations, declare a named `foreignKey` in the schema and use a guarded forward migration to rename the one matching live constraint without dropping it or touching data.