---
name: NFL web production build
description: Environment requirements for reproducing the NFL web artifact production build locally.
---

Local production builds of the NFL web artifact require both `PORT` and `BASE_PATH`; use the values declared for the artifact instead of invoking the package build with an empty shell environment.

**Why:** The Vite configuration validates both values during config loading, while Replit publishing injects them from the artifact service configuration automatically.

**How to apply:** When validating the production build from the workspace shell, provide the artifact-declared values. Publishing itself needs no manual environment workaround.