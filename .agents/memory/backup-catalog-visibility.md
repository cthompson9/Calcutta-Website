---
name: Backup catalog visibility
description: PostgreSQL read-only metadata visibility and bulk production-copy safety.
---

Snapshot exporters running as a SELECT-only backup role must discover primary
keys, unique indexes, and foreign-key targets through `pg_catalog`, not
`information_schema` constraint views.

**Why:** PostgreSQL can hide `information_schema.key_column_usage` and related
constraint rows from a role that has table SELECT access but does not own the
tables. The constraints still exist and remain visible through `pg_catalog`, so
an owner connection can appear healthy while the backup role reports missing
keys.

**How to apply:** Resolve each foreign key from its declared source and target
column arrays. Never infer the target from names such as `calcutta_id`, and
never emit a surrogate integer when metadata discovery or natural-key
registration is incomplete.

Use native PostgreSQL dump/restore for full production-to-dev refreshes, with a direct source connection forced read-only and a verified dev backup before replacement.

**Why:** Valuation history is too large for the query bridge's retained notebook state. Even bounded, checksum-verified query exports can exceed its 32 MiB notebook limit. They also cannot share one source transaction across calls.

**How to apply:** Use the read-only production query bridge for scoped inspection and verification, not full bulk transfer. Obtain any missing direct source connection through the secure secrets flow; never print credentials. Keep production read-only and validate the destination before restoring.

Treat read-replica row estimates as non-authoritative.

**Why:** Production `pg_stat_user_tables.n_live_tup` can report zero for populated tables, including large valuation histories.

**How to apply:** Use explicit counts or other authoritative evidence before deciding a table is empty. Also validate the query result's expected shape: a query failure can return transaction/rollback output even when the wrapper reports success.