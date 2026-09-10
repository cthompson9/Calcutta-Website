---
name: PostgreSQL polymorphic trigger dispatch
description: Safe row-field access when one PL/pgSQL trigger function serves tables with different shapes.
---

When one PL/pgSQL trigger function is attached to tables with different row shapes, dispatch on `TG_TABLE_NAME` first and access table-specific `NEW` or `OLD` fields only inside a nested branch.

**Why:** A combined condition such as `TG_TABLE_NAME = 'x' AND NEW.x_column ...` can still fail field resolution when invoked for another table whose row type lacks `x_column`.

**How to apply:** Use an outer `IF/ELSIF` per trigger table, then a nested condition for that table's fields. Exercise at least one unrelated-column update on every table sharing the function.