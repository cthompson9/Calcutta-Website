---
name: Week 0 market valuation
description: Durable policy for Kalshi-derived Week 0 MTM marks, data quality, and snapshot identity.
---

Week 0 valuations use reviewed, explicit Kalshi contract sets per supported NFL season. A mark is only live when the full regular-season win ladder and required postseason markets are usable, liquid, and fresh; missing, sparse, low-quality, or old data must remain visibly stale or incomplete with reasons.

**Why:** A partially populated or old market can produce a mathematically plausible number that is not a trustworthy live valuation. The audit view must not hide that uncertainty.

**How to apply:** Keep provenance, contract-set identity, quote diagnostics, and status reasons with every Week 0 snapshot. Treat the first successful Week 0 capture date as canonical for that season; later captures refresh those same rows rather than creating or moving the baseline. Serialize manual MTM writes and Week 0 captures by season so they cannot race to change this identity.