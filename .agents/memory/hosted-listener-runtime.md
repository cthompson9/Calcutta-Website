---
name: Hosted listener runtime
description: Build and security constraints for integrating the extracted desktop listener policy with the hosted API
---

Bundle the hosted listener's ticket policy with the API rather than resolving its source module through a relative runtime path.

**Why:** The API runs from a compiled distribution file, so source-relative paths can resolve outside the workspace after bundling. A build can typecheck while the service fails at startup.

**How to apply:** If the listener ticket algorithm changes, keep the bundled server policy in sync with the supplied source and verify the built API starts. Do not move Recall credentials or recording control into browser code.