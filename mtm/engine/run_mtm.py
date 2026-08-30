"""Orchestrator: one entrypoint for both the Tuesday cron and the admin button.

    python run_mtm.py --config season-config-2026.json \
                      --state state.json \
                      [--quotes cached_quotes.json] \
                      --out snapshot.json

STATE (produced by the repo's standings refresh + schedule loader; the repo's
scoring engine is the source of truth for everything realized):
{
  "as_of": "...",
  "pot": 123456.0,
  "entries": [{"entry_id": "...", "team": "KC", "price": 4200.0}],
  "realized": {"KC": {"wins": 5, "ties": 0, "adj_pt_diff": 61}, ...},
  "remaining_schedule": [{"home": "KC", "away": "BUF", "marquee": true, "week": 8}, ...],
  "divisions": {"AFC West": ["KC", ...], ...},
  "elimination_quotes": {"KC": {"no_playoffs": 0.08, ...}, ...},   # bid+1c, optional if fetching
  "win_ladders": {"KC": [{"strike": 9, "yes_bid": 0.61, "yes_ask": 0.66}, ...]}  # optional if fetching
}

OUTPUT snapshot.json: raw quotes echo, team projections, entry valuations,
diagnostics. The repo layer persists to mtm_* tables and flips the UI pointer
only on status == "ok".

Fetching lives behind --quotes so the transform stack is replayable offline
against stored quotes (quotes are evidence; keep them).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

import playoffs
import simulate
import valuation
import wins


def build_snapshot(config: dict, state: dict) -> dict:
    rubric = config["rubric"]
    games = config["games_per_team"]
    simcfg = config["sim"]
    teams = list(state["realized"].keys())

    # ---- wins: ladder -> E[W total] -> E[remaining] ----
    e_wins, win_diags = {}, {}
    for t in teams:
        rungs = [wins.Rung(r["strike"], r.get("yes_bid"), r.get("yes_ask"),
                           r.get("volume", 0)) for r in state["win_ladders"][t]]
        res = wins.expected_wins_from_ladder(rungs, games,
                                             config["pricing"]["max_spread_for_mid"])
        if res["e_wins"] is None:
            raise ValueError(f"unpriced win ladder for {t}")
        e_wins[t] = res["e_wins"]
        win_diags[t] = {"method": res["method"], **res["diagnostics"]}

    # ---- playoffs: elimination -> reach -> power-normalized ----
    reach_raw = {t: playoffs.reach_from_elimination(state["elimination_quotes"][t])
                 for t in teams}
    norm = playoffs.normalize_all(reach_raw, config["stage_targets"])

    # ---- point differential: market-calibrated ratings -> analytic E[diff] ----
    target_remaining = {t: max(e_wins[t] - state["realized"][t]["wins"], 0.0)
                        for t in teams}
    fit = simulate.fit_ratings(target_remaining,
                               [simulate.Game(**g) for g in state["remaining_schedule"]],
                               hfa=simcfg["hfa_points"], margin_sd=simcfg["margin_sd"],
                               lr=simcfg["rating_fit_lr"], iters=simcfg["rating_fit_iters"])
    diffs = simulate.expected_remaining_diff(
        fit["ratings"],
        [simulate.Game(**g) for g in state["remaining_schedule"]],
        hfa=simcfg["hfa_points"])

    # ---- assemble projections ----
    projections = {}
    for t in teams:
        projections[t] = {
            "e_wins_total": e_wins[t],
            "e_remaining_wins": round(target_remaining[t], 3),
            "e_remaining_ties": 0.0,   # documented choice; see SKILL.md ties note
            "e_remaining_raw_diff": diffs[t]["raw"],
            "e_remaining_marquee_addon": diffs[t]["marquee_addon"],
            "p_stage": norm["probs"][t],
            "rating": fit["ratings"][t],
        }

    valued = valuation.value_pool(rubric, state["realized"], projections,
                                  state["entries"], state["pot"])

    return {
        "status": "ok",
        "as_of": datetime.now(timezone.utc).isoformat(),
        "config_season": config["season"],
        "projections": projections,
        "valuations": valued["entries"],
        "diagnostics": {
            "wins": win_diags,
            "playoff_alphas": norm["alphas"],
            "playoff_residuals": norm["residuals"],
            "rating_fit_max_win_error": fit["max_abs_win_error"],
            **valued["diagnostics"],
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.config) as f:
        config = json.load(f)
    with open(args.state) as f:
        state = json.load(f)

    try:
        snapshot = build_snapshot(config, state)
    except Exception as e:  # failed snapshot: repo keeps serving the prior one
        snapshot = {"status": "failed", "error": str(e),
                    "as_of": datetime.now(timezone.utc).isoformat()}
    with open(args.out, "w") as f:
        json.dump(snapshot, f, indent=2)
    print(f"snapshot: {snapshot['status']}")
    return 0 if snapshot["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
