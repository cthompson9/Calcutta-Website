---
name: OpenAPI numeric fields
description: OpenAPI number typing compatibility with the workspace's Orval and Zod versions.
---

Use `type: number` for newly introduced numeric response fields in this workspace's OpenAPI specification.

**Why:** The current Orval/Zod combination generates `zod.int()` from OpenAPI `integer`, but the installed Zod version does not provide that API. `number` generates compatible validators and matches the existing public API convention.

**How to apply:** When adding IDs, years, counts, or similar response fields to the specification, use `number` unless and until the generator/runtime compatibility is deliberately updated and verified.