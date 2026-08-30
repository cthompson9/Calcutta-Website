---
name: Week 0 initialization concurrency
description: Concurrency and write-shape requirements for lazily creating Results reporting baselines.
---

Week 0 baseline creation must use bulk writes and concurrent requests for the same Calcutta must share one in-flight initialization.

**Why:** A first Results load can issue several requests at once. Hundreds of sequential inserts inside an advisory-lock transaction made the lock holder slow while waiters occupied every pooled connection, causing unrelated reads to fail with connection-acquisition timeouts.

**How to apply:** Keep baseline initialization idempotent, batch period/snapshot/metric upserts, and ensure same-process callers await one promise rather than each opening a lock-waiting transaction.