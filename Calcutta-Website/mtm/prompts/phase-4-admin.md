# Phase 4 — Admin trigger + UI

Paste to the Replit agent:

---

Surface the mark. Reuse `mtm/run.ts` — no new valuation logic anywhere in
this phase, and no changes to `mtm/engine/`.

**1. Admin recalc.** Admin-authenticated endpoint `POST
/api/pools/:id/mtm/recalc` that executes the full chain inline with
`trigger: 'manual'`, returns the snapshot id + status. Guard with a simple
lock: reject with 409 if a run for the pool started < 5 minutes ago.
Admin UI: a "Recalculate valuations" button showing run state and surfacing
the error string on failure.

**2. Valuations view.** Per-pool MTM table from the current snapshot:

- Per lot: team, owner, auction price, expected points, expected payout,
  MTM multiple (payout ÷ price), and delta vs the prior snapshot.
- Header: as-of timestamp, trigger type, staleness banner when `stale`.
- A diagnostics drawer (admin only): league coverage, per-stage alphas and
  residuals, rating-fit error, per-team wins method (flag any
  `single_rung_fallback`).

**3. Owner roll-up.** Sum expected payout per owner across their lots,
alongside total auction spend — the "book value" view. Follow the existing
owner roll-up view conventions from Stage 2.

Acceptance: button produces a `manual` snapshot end-to-end in under 2
minutes; the table's expected payouts sum to the pot × coverage (within
rounding); prior-snapshot deltas render; a failed manual run leaves the view
on the prior mark with the error visible in admin.

---
