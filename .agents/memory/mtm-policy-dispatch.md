---
name: MTM policy dispatch
description: Keeps official pricing-policy validation and routing synchronized across the API and Python engine.
---

Every supported official MTM pricing policy must appear in the TypeScript accepted-policy set, the Python pre-dispatch validator, and the Python engine branch that implements it. Keep one named constant per policy and use it in routing instead of repeating string literals.

**Why:** A policy was accepted by the API and had a complete engine branch, but the shared Python validator rejected it before dispatch. The recalculation failed safely while the prior mark remained current.

**How to apply:** When adding or renaming a policy, add a routing test that invokes the main engine dispatcher and asserts the intended implementation flags. Preserve unknown-policy and API/engine identity checks as fail-closed gates.