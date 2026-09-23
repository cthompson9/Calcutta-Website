---
name: Auction mutation parity
description: Consistency rule for commissioner inventory changes through the web API and MCP
---

Auction inventory can be changed through both HTTP and MCP. Review both paths together whenever changing the identity or lifecycle of a lot; passing checks on one path does not establish safety on the other.

**Why:** An independent implementation initially allowed MCP to remap a lot's underlying entry even though HTTP forbade it. That could silently change which team's ownership a future sale writes.

**How to apply:** Keep normalized external IDs, immutable entry mappings, completed/nominated restrictions, revision checks, and retry handling equivalent across both transports. Prefer shared domain validation over duplicating rules when expanding either path.