---
name: Zero-sum live marks
description: How pipeline expected payouts become comparable team net payouts in the Live Tracker.
---

For each successful pipeline snapshot, scale all expected payouts proportionally so their total equals that snapshot's total auction price, then subtract each team's auction price. Do not display raw expected payout minus price as the zero-sum net mark.

**Why:** Modeled league-point coverage can differ slightly from 1.0, so raw expected payouts may not equal the auction pool even when the engine is working correctly. Scaling preserves relative team valuations while making gains and losses reconcile to zero.

**How to apply:** Use one scale factor per snapshot, never one factor across multiple weeks. Missing auction prices remain unavailable rather than being treated as zero.