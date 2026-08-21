---
name: Short position semantics
description: Rules for representing sale positions that exceed a participant's long ownership.
---

Approved trades may create or increase a negative effective ownership position. Current-owner displays must remain limited to positive effective stakes, while participant and owner-level financial reporting must preserve signed shares.

**Why:** Pool participants can sell a position without having drafted, or sell more than their existing long stake. Calling them a current owner would be misleading, while discarding the negative position would misstate their economics.

**How to apply:** Keep primary auction ownership unchanged; use the approved-trade ledger for longs and shorts. Include both trade parties as season participants, exclude nonpositive stakes from team-owner lists, and apply signed shares wherever a report represents position economics.