---
name: Immutable MTM evidence
description: Audit-integrity rule for frozen-engine attempts and their stored market evidence.
---

Every MTM pipeline execution is a distinct, immutable audit attempt, including retries within the same hour. A later execution must never replace an earlier attempt's quotes, diagnostics, projections, or valuations.

**Why:** Commissioners need to inspect successful, failed, and incomplete executions independently. Coalescing retries by hour can erase the exact evidence and source failures that explain an earlier mark attempt.

**How to apply:** Use hourly timestamps only for lookup and cooldown behavior. Any pipeline execution that reaches persistence must receive a new attempt identity, and finalized child evidence must be append-only.