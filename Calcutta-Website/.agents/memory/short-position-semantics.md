---
name: Short position semantics
description: Rules for representing sale positions that exceed a participant's long ownership.
---

Approved trades may create or increase a negative effective ownership position. Current-owner displays must remain limited to positive effective stakes, while participant and owner-level financial reporting must preserve signed shares.

**Why:** Pool participants can sell a position without having drafted, or sell more than their existing long stake. Calling them a current owner would be misleading, while discarding the negative position would misstate their economics.

**Reporting clarification:** Results must visibly surface signed positions, including leveraged longs above 100% and negative shorts, with a clear per-team net-100% reconciliation.

**Why:** The pool permits short positions. Hiding those legs makes the displayed positive stakes look incomplete or over-owned even when the signed ledger is correct.

**How to apply:** Keep primary auction ownership unchanged; use the approved-trade ledger for longs and shorts. Include both trade parties as season participants, exclude nonpositive stakes from current-owner lists, and derive Results position views from the full signed ledger rather than positive owners alone.