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


def _build_snapshot(config: dict, state: dict,
                    runtime: simulate.RuntimeDiagnostics | None = None,
                    *, enforce_gate: bool = True) -> dict:
    runtime = runtime or simulate.RuntimeDiagnostics()
    rubric = config["rubric"]
    games = config["games_per_team"]
    simcfg = config["sim"]
    teams = list(state["realized"].keys())

    # ---- wins: ladder -> E[W total] -> E[remaining] ----
    e_wins, win_diags = {}, {}
    with runtime.stage("wins"):
        for t in teams:
            rungs = [wins.Rung(r["strike"], r.get("yes_bid"), r.get("yes_ask"),
                               r.get("volume", 0), r.get("status"), r.get("result"))
                     for r in state["win_ladders"][t]]
            res = wins.expected_wins_from_ladder(rungs, games,
                                                 config["pricing"]["max_spread_for_mid"])
            if res["e_wins"] is None:
                raise ValueError(f"unpriced win ladder for {t}")
            e_wins[t] = res["e_wins"]
            win_diags[t] = {"method": res["method"], **res["diagnostics"]}

    # ---- playoffs: elimination -> reach -> power-normalized ----
    with runtime.stage("playoff_normalization"):
        reach_raw = {t: playoffs.reach_from_elimination(state["elimination_quotes"][t])
                     for t in teams}
        norm = playoffs.normalize_all(reach_raw, config["stage_targets"])

    # ---- point differential: market-calibrated ratings -> analytic E[diff] ----
    target_remaining = {t: max(e_wins[t] - state["realized"][t]["wins"], 0.0)
                        for t in teams}
    with runtime.stage("rating_fit"):
        fit = simulate.fit_ratings(
            target_remaining,
            [simulate.Game(**g) for g in state["remaining_schedule"]],
            hfa=simcfg["hfa_points"], margin_sd=simcfg["margin_sd"],
            lr=simcfg["rating_fit_lr"], iters=simcfg["rating_fit_iters"],
            diagnostics=runtime)
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

    with runtime.stage("analytic_valuation"):
        valued = valuation.value_pool(rubric, state["realized"], projections,
                                      state["entries"], state["pot"])
    # The simulated, path-normalized mark is authoritative.  The analytic
    # valuation above remains in the snapshot for backwards compatibility and
    # audit comparison.
    schedule = [simulate.Game(**g) for g in state["remaining_schedule"]]
    seed = simcfg.get("seed", 20260829)
    with runtime.stage("monte_carlo"):
        fitted_total_wins = simulate.implied_total_wins(
            fit["ratings"], schedule,
            {t: state["realized"][t]["wins"] for t in teams},
            hfa=simcfg["hfa_points"], margin_sd=simcfg["margin_sd"])
        mc = simulate.monte_carlo(
            fit["ratings"], schedule,
            {t: state["realized"][t]["wins"] for t in teams},
            state.get("divisions", {}), hfa=simcfg["hfa_points"],
            margin_sd=simcfg["margin_sd"], runs=simcfg["monte_carlo_runs"],
            seed=seed, rubric=rubric, pot=state["pot"],
            realized_stats=state["realized"], stage_targets=norm["probs"],
            calibration_tolerance=simcfg.get("calibration_tolerance", 0.03),
            calibration_iters=simcfg.get("calibration_iters", 500),
            support_runs_per_team=simcfg.get("support_runs_per_team", 0),
            support_prior_weight=simcfg.get("support_prior_weight", 0.01),
            diagnostics=runtime)
    if enforce_gate and not mc.get("calibration_converged", False):
        worst = max((abs(value) for value in mc.get("calibration_residuals", {}).values()),
                    default=float("inf"))
        raise ValueError(f"playoff market calibration failed; max residual {worst:.6f}")
    with runtime.stage("simulation_valuation"):
        sim_valued = valuation.value_simulation(
            rubric, state["entries"], state["pot"], mc, schedule,
            min_conditional_samples=simcfg.get("min_conditional_samples", 100),
            min_conditional_share=simcfg.get("min_conditional_share", 0.01))
    # Keep legacy point fields stable for consumers while replacing only the
    # payout mark with the path-normalized result.
    legacy_by_entry = {r["entry_id"]: r for r in valued["entries"]}
    for row in sim_valued["entries"]:
        old = legacy_by_entry.get(row["entry_id"], {})
        row["expected_points"] = old.get("expected_points")
    # Calibration is intentionally normalized and explicit: weights are the
    # number of simulated observations, residuals compare each bucket's
    # weighted estimate with the unconditional estimate.
    calibration = []
    tolerance = simcfg.get("calibration_tolerance", 0.03)
    for t in teams:
        n_games = sum(1 for g in schedule if g.home == t or g.away == t)
        target = target_remaining[t] / n_games if n_games else 0.0
        simulated = ((fitted_total_wins[t] - state["realized"][t].get("wins", 0))
                     / n_games) if n_games else 0.0
        posterior = ((mc.get("win_sum", {}).get(t, 0.0) / mc["runs"])
                     - state["realized"][t].get("wins", 0)) / n_games if n_games else 0.0
        calibration.append({"metric": "remaining_win_probability", "team": t,
                            "target_probability": target,
                            "simulated_probability": simulated,
                            "residual": simulated - target, "weight": n_games,
                            "tolerance": tolerance, "sample_count": mc["runs"],
                            "sample_share": 1.0,
                            "effective_sample_size": mc["runs"],
                            "sample_metadata": {
                                "posterior_probability": posterior,
                                "posterior_shift": posterior - simulated,
                                "calibration_basis": "schedule_feasible_rating_fit",
                            },
                            "quality_status": "good" if abs(simulated-target) <= tolerance else "warning"})
    for stage in playoffs.STAGES:
        target_total = config["stage_targets"][stage]
        for t in teams:
            target = norm["probs"][t][stage]
            sim = mc["stage_probs"][t][stage]
            calibration.append({"metric": stage, "team": t,
                                "target_probability": target,
                                "simulated_probability": sim,
                                "residual": sim - target,
                                "weight": target_total, "tolerance": tolerance,
                                "sample_count": mc["runs"], "sample_share": 1.0,
                                "effective_sample_size": mc.get("effective_sample_size", mc["runs"]),
                                "quality_status": "good" if abs(sim-target) <= tolerance else "warning"})
    failed_calibration = [row for row in calibration if row["quality_status"] != "good"]
    if failed_calibration and enforce_gate:
        worst = max(abs(row["residual"]) for row in failed_calibration)
        raise ValueError(
            f"market calibration failed for {len(failed_calibration)} metrics; "
            f"max residual {worst:.6f}"
        )

    return {
        "status": "ok" if enforce_gate else "candidate",
        "as_of": datetime.now(timezone.utc).isoformat(),
        "config_season": config["season"],
        "projections": projections,
        "valuations": sim_valued["entries"],
        "team_valuations": sim_valued["team_valuations"],
        "path_count": mc["runs"],
        "model": {"name": simcfg.get("model", "seeded_monte_carlo"), "seed": seed,
                  "runs": mc["runs"], "margin_sd": simcfg["margin_sd"],
                  "hfa_points": simcfg["hfa_points"]},
        "conditional_payouts": sim_valued["conditional_payouts"],
        "diagnostics": {
            "runtime": runtime.snapshot(),
            "wins": win_diags,
            "playoff_alphas": norm["alphas"],
            "playoff_residuals": norm["residuals"],
            "rating_fit_max_win_error": fit["max_abs_win_error"],
            "rating_fit": fit.get("fit_diagnostics", {}),
            **valued["diagnostics"],
            "simulation": sim_valued["diagnostics"],
            "support_sampling": mc.get("support_sampling", {}),
            "calibration": mc.get("calibration_diagnostics", {}),
            "market_calibration": {"metrics": calibration,
                "status": "good" if all(v["quality_status"] == "good"
                                        for v in calibration) else "warning",
                "calibration_status": "good" if all(
                    v["quality_status"] == "good" for v in calibration) else "warning"},
        },
    }


def build_snapshot(config: dict, state: dict,
                   runtime: simulate.RuntimeDiagnostics | None = None) -> dict:
    """Build an official snapshot; production callers always enforce the gate."""
    return _build_snapshot(config, state, runtime=runtime, enforce_gate=True)


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

    runtime = simulate.RuntimeDiagnostics()
    simulate.install_sigterm_diagnostics(runtime)
    try:
        snapshot = build_snapshot(config, state, runtime=runtime)
    except Exception as e:  # failed snapshot: repo keeps serving the prior one
        snapshot = {"status": "failed", "error": str(e),
                    "as_of": datetime.now(timezone.utc).isoformat(),
                    "diagnostics": {"runtime": runtime.snapshot()}}
    with open(args.out, "w") as f:
        json.dump(snapshot, f, indent=2)
    print(f"snapshot: {snapshot['status']}")
    return 0 if snapshot["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
