---
name: Reference-market read contract
description: Contract boundaries shared by official MTM reference-market REST and MCP reads.
---

Reference-market reads are projections of one immutable official source snapshot. REST and MCP call the same service directly, cursors pin the snapshot and filters, and outputs are sanitized allowlists.

**Why:** Combining quote rows across runs or performing provider work during reads would break auditability and transport parity.

**How to apply:** Reads must not fetch providers, reselect marks, de-vig, write, or recalculate. Preserve carry-forward provenance, distinguish raw reference price from fair probability and gross valuation, and expose pending/provisional state alongside the archived official source.