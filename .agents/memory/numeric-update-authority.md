---
name: Numeric update authority
description: Defines the boundary between automatic settled-result ingestion and commissioner-triggered market valuation.
---

Games, scores, standings, and cumulative realized values may refresh automatically and may reconcile provider corrections. MTM snapshots and unsettled bracket forecasts must update only when a commissioner explicitly requests recalculation. Every MTM attempt remains immutable, and a failed attempt cannot replace the last successful mark.

**Why:** Automatic factual result updates should not silently create new financial market observations or forecasts. Those values have different provenance, audit, and failure semantics.

**How to apply:** Keep external schedulers and background jobs limited to settled-result ingestion. Route all MTM and bracket-forecast publication through the authenticated manual recalculation transaction, while allowing settled bracket facts to follow authoritative results where an adapter exists.