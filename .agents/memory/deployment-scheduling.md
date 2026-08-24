---
name: External refresh scheduling
description: The Autoscale app uses an external GitHub Actions tick instead of a second Replit deployment.
---

The NFL standings refresh is request-driven: GitHub Actions calls the dedicated job endpoint every five minutes while the live NFL Auction app stays on Autoscale.

**Why:** Replit's Publishing model cannot co-host an Autoscale website and a Scheduled Deployment in one project. An external tick preserves the live app and lets Autoscale wake only when needed.

**How to apply:** Keep scheduling outside Replit. Preserve the dedicated job authorization and overlap protection; never substitute the commissioner key or reintroduce a second Replit deployment.