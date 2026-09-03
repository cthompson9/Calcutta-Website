# Backload the history and wire up the tie-out

_New work. This is the acceptance test for the whole of Stage 1._

```
Load the eleven historical Calcuttas from /data/calcutta-01..11.json in this handoff, then
wire the reconciliation up as a test that runs in CI.

/reference/load_and_verify.py is a working reference implementation of both the loader and
the two-pass scoring engine — port it, don't reinvent it. /DATA-CONTRACT.md documents every
field of the JSON.

LOADER
- One transaction per pool. A pool either loads completely or not at all.
- Record provenance in import_runs with the source file's SHA-256, per
  .agents/memory/atomic-season-backloads.md. Re-running the same file is a no-op.
- expected_entry_results and expected_owner_results hold each workbook's OWN answers. They
  are comparison targets only and must never be read by a calculation. Enforce that by
  keeping them out of every query the engine runs.
- Owner identity: a full name (contains a space) is a global identity; a bare first name or
  initials stays scoped to its pool. Do NOT merge on label similarity — "Zach" and "Zack"
  are different people, as are "Joey Anthony" and "Anthony C.". The load produces 73 owner
  records for roughly twenty humans; merging them is a separate manual step, gated on
  decisions/OWNER-IDENTITY.md.

THE TEST — the engine recomputes every payout from events + rules ALONE and must reproduce:

    456 / 456   lot payouts tie to the cent
    112 / 112   point totals tie
     82 /  82   owner roll-ups tie
     11 /  11   pools where the engine's total payout equals the pot exactly

Tolerance is one cent on payouts. Anything less than 456/456 is a bug in the implementation,
not in the data — the reference implementation reaches it, so the data supports it.

Make this a real test in the repo's suite, not a script someone remembers to run. It is the
regression net for every later change to the scoring engine.

READ VIEWS — port reference/views.sql: v_entry_results (team-by-team with a plain-language
tracking narrative built from scoring_events, no dollars in the narrative) and
v_owner_results (fractional lot counts, cost, payout). Their output must match
team-by-team.csv and owner-by-owner.csv in this handoff exactly.
```
