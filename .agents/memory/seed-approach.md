---
name: Seed approach
description: How to run the DB seed scripts for the NFL auction project.
---

## Running seed2025.ts

tsx is not in PATH. Run with:
```
node --import /home/runner/workspace/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/esm/index.mjs lib/db/src/seed2025.ts
```

Or via the package script: `pnpm --filter @workspace/db run seed2025`
(script uses `node --import tsx/esm src/seed2025.ts` — but the full path above is more reliable)

## Season IDs

- 2025 season: id=1 (isComplete=true)
- 2026 season: id=2 (isActive=true)

**Why:** Seasons were inserted in order 2025 first, so serial IDs are predictable. But always resolve by year, not by hardcoded id.
