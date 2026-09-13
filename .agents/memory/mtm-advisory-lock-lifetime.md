---
name: MTM advisory lock lifetime
description: Production constraint on database-session advisory locks around long MTM calculations.
---

Do not hold a PostgreSQL session-level advisory-lock connection across the full MTM input-fetch and Python-engine execution. Use a durable lease or another coordination design that tolerates managed-database connection termination, and ensure pooled clients have an error path that cannot crash the API process.

**Why:** In production, the managed database terminated the long-held lock connection with an administrator command while the engine was running. The unhandled client error crashed the API process, leaving an append-only attempt incomplete and unpromoted even though the same calculation worked in development.

**How to apply:** Any production-capable MTM recalculation or review path that can run for minutes must avoid depending on one continuously open database session for mutual exclusion. Recovery must leave the prior official mark active and clearly classify abandoned attempts.