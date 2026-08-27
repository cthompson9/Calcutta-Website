---
name: Provider event reconciliation
description: Completeness and replacement rules for provider-backed event ledgers across sports.
---

CFB provider payloads must reconcile through sport-, competition-, season-, provider-, and event-scoped upserts. Do not delete the prior provider slice unless the source supplies a trustworthy completeness signal for that exact snapshot.

**Why:** ESPN's college-football date-range response does not expose an authoritative completeness marker. Treating a merely nonempty or plausibly large response as complete can erase valid events during a partial response.

**How to apply:** Repeated and corrected events update in place by their scoped provider identity. Preserve unrelated events during partial payloads; only add withdrawal cleanup if a future adapter can prove complete coverage independently of row count.