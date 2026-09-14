---
name: MTM v3 review boundary
description: Separates successful review execution from statistical readiness and canonical publication.
---

The v3 MTM engine is review-only. A run may complete successfully while remaining unready because generated win/playoff fit, outcome support, ESS, payout standard errors, conditional quality, or stability do not pass review thresholds. Never interpret execution success as publication approval.

**Why:** The retained 2026 state produced complete rare-event support and strong global ESS while still showing large playoff-market residuals and dollar instability. A residual gate alone would hide the underlying generative-model problem.

**How to apply:** Persist full review diagnostics, label readiness separately, and exclude review attempts from production latest-attempt/canonical selection. Official promotion and read-side “official” classification must use the same immutable complete-audit predicate; missing, malformed, or failed required gates fail closed.