---
name: Deterministic MTM promotion
description: Defines how concurrent validated MTM contenders converge on one current mark.
---

Current-mark promotion must acquire the pool advisory lock inside a READ COMMITTED transaction, then rank every validated contender by actuals cutoff, MTM cutoff, explicit mark-state precedence, and a canonical content fingerprint.

**Why:** An advisory lock inside a SERIALIZABLE transaction can wait with an already-frozen snapshot, hiding the contender that committed while it waited. Unconditional replacement then makes the winner depend on scheduling.

**How to apply:** Read the current mark only after acquiring the lock. Retain losing valid contenders as superseded audit rows. Use locale-independent canonicalization and never use row IDs, creation times, lock arrival, or random run identity as tie-breakers.