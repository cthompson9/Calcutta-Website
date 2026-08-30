# Phase 1 — Schema + state exporter

Paste to the Replit agent:

---

Add the mark-to-market storage layer and the state exporter. Additive only:
new tables, new files. Do not modify any table or code path the live pool
reads. Do not modify anything under `mtm/engine/` — that Python is frozen and
tested.

**1. Migration.** Create the four `mtm_*` tables exactly as specified in
`mtm/skill/references/integration.md` (mtm_snapshot, mtm_market_quote,
mtm_team_projection, mtm_entry_valuation), adapted to our Drizzle conventions
in `lib/db`. Follow the same additive-migration pattern used in Stage 1.

**2. Exporter.** New script `mtm/export-state.ts` (wired into the scripts
workspace like our other jobs) that produces `state.json` matching the
contract in `integration.md`, section "state.json contract":

- `pot`, `entries` (entry_id, team, price) from the live pool's tables.
- `realized` per team (wins, ties, adj_pt_diff) **read from the scoring
  engine's outputs** — the same numbers the standings page shows. Do not
  recompute from game rows.
- `remaining_schedule` with `marquee` flags. Marquee = kickoff outside
  Sunday 1:00–7:00pm ET. Reuse the existing window test from the scoring
  code (per RULES.md, the code's test is authoritative, not the rubric
  prose). Include Saturday and international games.
- `divisions` for all 32 teams.
- Leave `win_ladders` and `elimination_quotes` as empty objects — Phase 2
  fills them.

**3. Validation.** Add a validator (zod, consistent with `lib/api-zod`) for
the state shape, and a test that (a) the exporter output parses, and (b) each
team's realized wins/ties/adj_pt_diff equal the scoring engine's current
values exactly — to the point, not approximately.

Acceptance: exporter runs against the live DB, output validates, realized
values tie exactly.

---
