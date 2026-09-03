---
name: Backup catalog visibility
description: PostgreSQL metadata visibility rules for logical snapshots run by the read-only backup role.
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