---
name: MTM calibration bands
description: Why production playoff calibration targets tolerance bands and how path count is selected.
---

Calibrate playoff marginals into the existing quality-gate bands rather than forcing every independently normalized market marginal to its exact point estimate. Keep the final gate unchanged and reject targets with no simulated support.

**Why:** Exact point calibration can cycle even when every target has support and every simulated path preserves the exact NFL stage inventory. Projecting violated coordinates to a point safely inside the accepted band finds a valid distribution without weakening the gate.

**How to apply:** Preserve deterministic coordinate order, redundant-inventory anchor handling, support checks, and final all-target residual validation. Select path count from matching-state ESS plus entry and conditional EV stability against a larger reference, not runtime alone.