---
name: Polymorphic delete triggers
description: Safe field access in PostgreSQL trigger functions shared by tables with different row shapes.
---

When one PostgreSQL trigger function is attached to multiple tables, branch on `TG_TABLE_NAME` before accessing any field that is not common to every attached row type. Do not rely on a compound boolean condition to protect access to a table-specific `OLD` or `NEW` field.

**Why:** PostgreSQL can resolve a record-field reference even when another boolean term appears to make that branch unreachable, causing deletion to fail with `record "old" has no field ...`.

**How to apply:** Use nested `IF` blocks for table-specific rules in shared trigger functions, and include a behavior test using a trigger-protected row that lacks the field.