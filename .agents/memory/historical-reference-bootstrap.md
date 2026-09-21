---
name: Historical reference bootstrap
description: Rules for initializing exact-contract MTM marks from official history without inventing market evidence.
---

Bootstrap exact-contract reference marks newest-first from successful official snapshots. Use the saved raw book under the active selector rules; when no book qualifies, an identifiable saved pre-de-vig input may seed the same exact elimination contract. Preserve the originating snapshot, timestamp, ticker, event identity, and selection method across repeated carry-forward.

Never turn a final valuation, fitted probability, interpolation, midpoint, or broad book bound into a historical accepted raw mark. A supported missing win rung remains explicitly model-derived with a null observed reference; mandatory elimination inputs still fail closed.

**Why:** The first post-policy refresh had valid official history but could not see it, while one win rung had only bounds and no honest historical point mark.

**How to apply:** Use canonical numeric strikes and a ticker-derived event identity for current, expected, and historical candidates. Keep current observations immutable, pass resolved scalars unchanged into pricing, and expose raw references separately from fair probabilities.