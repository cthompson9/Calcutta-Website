---
name: API page-fanout rate limits
description: Broad API throttling must account for Replit proxy traffic, frontend query fan-out, retries, and long-job polling.
---

Keep the general API request ceiling high enough that normal page queries, frontend retries, and commissioner-job polling cannot lock every API-backed page. Protect credential checks and other sensitive operations with separate, much tighter limits.

**Why:** In development, a recalculation's status polling exhausted a low shared broad limit. React Query retries then amplified the 429 responses, leaving the entire application stuck in loading states even though the recalculation had failed safely.

**How to apply:** When changing API throttling or adding polling, evaluate the complete browser request fan-out and retry behavior. Retain dedicated strict limiters for authentication and sensitive endpoints instead of relying on the broad ceiling.