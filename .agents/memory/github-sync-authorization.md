---
name: GitHub sync authorization
description: Connector permissions can allow file initialization while denying Git ref updates and merge operations.
---

Use the Replit Git pane to connect and push this workspace to GitHub when the attached GitHub connector cannot update refs or merge a branch.

**Why:** The connector may initialize repository contents but still receive GitHub authorization errors for branch-reference updates and merges, which makes an API-based single-commit sync impossible.

**How to apply:** Prefer a normal Git-pane push rather than a Contents API fallback that would create one commit per file. Confirm the GitHub target repository and branch before pushing.