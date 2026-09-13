---
name: MTM production CPU budget
description: Production capacity constraint discovered while verifying the optimized MTM engine.
---

Run official MTM recalculations on a Reserved VM with enough CPU for the frozen engine. Do not use an Autoscale request handler as a background worker, and do not assume a same-state local benchmark will fit the production timeout. Verify the deployment worker's reported capacity and end-to-end wall time before approving engine performance.

**Why:** The optimized 40,000-path engine completed locally in about 23 seconds, but a throttled Autoscale worker reached only 37,459 paths after about 14 minutes and was terminated before residual and ESS diagnostics existed. A higher-capacity Autoscale attempt completed the engine but was interrupted before promotion during the switch to a Reserved VM. The same frozen engine then completed and promoted safely on a 0.5-vCPU Reserved VM.

**How to apply:** Preserve model configuration and solver semantics while measuring on the actual deployment capacity. Keep the production deployment on a Reserved VM for commissioner recalculations, and re-run operational verification after any machine-size or deployment-type change.