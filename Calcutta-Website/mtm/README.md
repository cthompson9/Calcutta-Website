# NFL Mark-to-Market Engine — Implementation Handoff

Drop the contents of this zip into the repo at `mtm/` and work through the
phases below in order. Each phase is a self-contained prompt you can paste to
the Replit agent, with an objective acceptance test — same pattern as the
Stage 0–3 handoff.

```
README.md                    this file — the sequence
skill/                       the valuation engine (also installable as a Claude skill)
  SKILL.md                   methodology + new-season checklist
  scripts/                   working, smoke-tested Python (the engine)
    kalshi_client.py         read-only Kalshi public API client (no auth)
    wins.py                  win ladder -> E[wins]
    playoffs.py              elimination -> normalized stage probabilities
    simulate.py              market-calibrated ratings, E[pt diff], Monte Carlo
    valuation.py             E[points] -> share -> payout
    run_mtm.py               single orchestrator entrypoint (CLI)
    test_smoke.py            run this first; all five tests must pass
  assets/season-config-2026.json   the ONLY file that changes next season
  references/integration.md  state.json contract, DDL, refresh.yml wiring
prompts/
  phase-1-schema.md          mtm_* tables + exporter
  phase-2-fetch.md           Kalshi fetch + ticker confirmation
  phase-3-pipeline.md        wire the cron + persist step
  phase-4-admin.md           admin button + UI surfaces
```

## Ground rules for the agent (repeat these in every prompt)

1. **Additive only.** New `mtm_*` tables, new files under `mtm/`. Nothing in
   this project alters a table or code path Calcutta XII reads today.
2. **The Python engine is frozen.** `skill/scripts/*.py` is tested and
   correct. The agent integrates around it; it does not "improve" the math.
   Any change to those files must first update `test_smoke.py` and pass.
3. **Realized facts come from the existing two-pass scoring engine.** The
   exporter reads them; nothing in `mtm/` recomputes a played game.
4. **Never a partial mark.** A run either writes a complete `ok` snapshot or
   a `failed` row. The UI pointer only advances on `ok`.
5. **Quotes are evidence.** Every raw Kalshi quote is persisted before any
   transform runs, so historical snapshots can be re-derived when methods
   improve.

## Placement

- `mtm/engine/` ← copy of `skill/scripts/` (the Python engine)
- `mtm/season-config-2026.json` ← copy of `skill/assets/season-config-2026.json`
- Exporter + persist code in TypeScript alongside existing `scripts/src`
  conventions (see `references/integration.md` for the seam).
- Keep the `skill/` folder itself out of the app build; it is documentation +
  the installable Claude skill.

## Acceptance test per phase

| Phase | Passes when |
|---|---|
| 1 | `state.json` exports from the live DB and validates against the contract in `references/integration.md`; realized values tie exactly to the scoring engine's current standings |
| 2 | A fetch run persists quotes for all 32 teams' win ladders + elimination markets; `run_mtm.py` on that state returns `status: ok`; `diagnostics.coverage` within 0.98–1.02 |
| 3 | Tuesday cron produces one snapshot row (not two, despite the doubled UTC cron); a forced fetch failure produces a `failed` row and the UI still serves the prior mark with a staleness flag |
| 4 | Admin button triggers a `manual` snapshot end-to-end in < 2 min; per-lot MTM renders with expected payout and MTM multiple vs auction price |

## Before anything else

```bash
cd mtm/engine && python3 test_smoke.py   # all five must pass
```

If the environment lacks Python 3.11+, add it via Replit's module system;
the engine's only third-party dependency is `requests` (fetch path only —
transforms are stdlib).

## The one open item requiring a human look

The game-spread series ticker is marked
`CONFIRM_AT_SEASON_START` in the season config. Stage of Elimination is confirmed: KXNFLSTAGEOFELIM (events KXNFLSTAGEOFELIM-27{TEAM}). Phase 2 includes the
discovery step (`GET /events?series_ticker=...` against candidates, or list
series and grep). Confirm them against kalshi.com before the first scheduled
run; win totals (`KXNFLWINS`) and game winners (`KXNFLGAME`) are confirmed.
