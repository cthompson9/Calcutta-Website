#!/usr/bin/env python3
"""CLI for the noncanonical v3 MTM review engine."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import engine_v3
import joint_fit
import playoffs
import simulate
import wins


def _effective_v3_config(config: dict) -> dict:
    sim = config["sim"]
    review = config.get("sim_v3_review", {})
    return {
        "runs": int(review.get("runs", sim.get("monte_carlo_runs", 20000))),
        "pilot_runs": int(review.get("pilot_runs", 2000)),
        "seed": int(review.get("seed", sim.get("seed", 20260829))),
        "hfa": float(review.get("hfa_points", sim.get("hfa_points", 1.6))),
        "margin_sd": float(review.get("margin_sd", sim.get("margin_sd", 13.5))),
        "strength_sd": float(review.get("latent_strength_sd", 3.0)),
        "tie_window": float(review.get("tie_window_points", .075)),
        "futures_scale": float(review.get("playoff_futures_rating_scale", 1.25)),
        "proposal_shift": float(review.get("proposal_shift_points", 5.0)),
        "proposal_fraction": float(review.get("max_proposal_fraction", .25)),
        "residual_trigger": float(review.get("residual_adaptation_trigger", .04)),
        "min_target_hits": int(review.get("min_target_hits", 25)),
        "min_global_ess": float(review.get("min_global_ess", 1000)),
        "max_team_mc_se": float(review.get("max_team_payout_mc_se", 10.0)),
        "max_split_half_difference": float(
            review.get("max_split_half_difference", 15.0)),
        "min_conditional_ess": float(
            review.get("min_conditional_ess", sim.get("min_conditional_samples", 100))),
        "min_conditional_share": float(
            review.get("min_conditional_share", sim.get("min_conditional_share", .01))),
        "max_win_residual": float(review.get("max_generated_win_residual", .25)),
        "max_playoff_residual": float(review.get("max_playoff_residual", .05)),
        "return_path_library": bool(review.get("return_path_library", True)),
        "max_joint_weight": float(review.get("max_joint_weight", .01)),
        "joint_interval_tolerance": float(review.get("joint_interval_tolerance", 1e-9)),
        "joint_group_caps": review.get("joint_group_caps", review.get("group_caps", {})),
    }


def _code_version() -> str:
    digest = hashlib.sha256()
    for name in ("engine_v3.py", "joint_fit.py", "run_mtm_v3.py"):
        digest.update(Path(__file__).with_name(name).read_bytes())
    return f"nfl-mtm-v3-review-{digest.hexdigest()[:12]}"


def build_review_snapshot(config: dict, state: dict) -> dict:
    as_of = datetime.now(timezone.utc).isoformat()
    settings = _effective_v3_config(config)
    diagnostics = {"engine_code_version": _code_version(),
                   "effective_config": settings, "review_only": True}
    try:
        teams = sorted(state["realized"])
        expected_wins = {}
        win_diagnostics = {}
        for team in teams:
            rungs = [wins.Rung(row["strike"], row.get("yes_bid"), row.get("yes_ask"),
                               row.get("volume", 0), row.get("status"),
                               row.get("result"))
                     for row in state["win_ladders"][team]]
            result = wins.expected_wins_from_ladder(
                rungs, config["games_per_team"], config["pricing"]["max_spread_for_mid"])
            if result["e_wins"] is None:
                raise ValueError(f"unpriced win ladder for {team}")
            expected_wins[team] = result["e_wins"]
            win_diagnostics[team] = {"method": result["method"], **result["diagnostics"]}
        raw_reach = {team: playoffs.reach_from_elimination(state["elimination_quotes"][team])
                     for team in teams}
        normalized = playoffs.normalize_all(raw_reach, config["stage_targets"])
        games = [engine_v3.Game(**row) for row in state["remaining_schedule"]]
        rating_games = [simulate.Game(**row) for row in state["remaining_schedule"]]
        remaining_targets = {
            team: max(expected_wins[team] - float(state["realized"][team]["wins"]), 0.0)
            for team in teams
        }
        effective_margin_sd = (
            settings["margin_sd"] ** 2 + 2 * settings["strength_sd"] ** 2
        ) ** .5
        fitted = simulate.fit_ratings(
            remaining_targets, rating_games, hfa=settings["hfa"],
            margin_sd=effective_margin_sd, lr=config["sim"].get("rating_fit_lr", .5),
            iters=config["sim"].get("rating_fit_iters", 200))
        market_means = engine_v3.blend_playoff_futures(
            fitted["ratings"], normalized["probs"], settings["futures_scale"])
        simulation_settings = {
            key: value for key, value in settings.items()
            if key != "futures_scale"
        }
        result = engine_v3.simulate_v3(
            ratings=market_means, games=games,
            completed_results=state.get("completed_results", []),
            realized=state["realized"], divisions=state["divisions"],
            rubric=config["rubric"], pot=float(state["pot"]),
            playoff_targets=normalized["probs"],
            win_targets=expected_wins, **simulation_settings)
        diagnostics.update({
            "win_ladders": win_diagnostics,
            "rating_fit_max_win_error": fitted["max_abs_win_error"],
            "base_schedule_ratings": fitted["ratings"],
            "market_blended_rating_means": market_means,
            "playoff_normalization": {"alphas": normalized["alphas"],
                                      "residuals": normalized["residuals"]},
            "simulation": result.get("diagnostics", {}),
        })
        # The v3 generator is the supported review path.  Reuse its legal
        # worlds rather than asking callers to smuggle a second scenario
        # library through state.
        path_library = result.get("path_library", [])
        if not path_library:
            raise ValueError("review simulation did not return its legal path library")
        scenarios = joint_fit.scenarios_from_path_library(
            path_library, teams=teams, realized=state["realized"]
        )
        evidence = state.get("joint_fit_constraints")
        if evidence is None:
            evidence = joint_fit.constraints_from_markets(state)
        resolved = {
            f"actual:wins:{team}": float(state["realized"][team].get("wins", 0))
            for team in teams
        }
        joint_review = config.get("joint_fit_review", {})
        if not isinstance(joint_review, dict):
            joint_review = {}
        joint_result = simulate.fit_joint_review(
            scenarios,
            evidence,
            resolved_facts=resolved,
            precision_caps=state.get("joint_fit_group_caps", settings["joint_group_caps"]),
            max_iterations=int(joint_review.get(
                "max_iterations", 2000
            )),
            tolerance=float(joint_review.get(
                "tolerance", 1e-9
            )),
            learning_rate=float(joint_review.get(
                "learning_rate", .2
            )),
        )
        joint_summary = joint_fit.summarize_path_library(
            scenarios, joint_result["weights"], pool=float(state["pot"])
        )
        joint_diag = joint_result["diagnostics"]
        min_ess = max(1000.0, .05 * len(scenarios))
        gate_checks = {
            "global_ess": joint_diag["effective_sample_size"] >= min_ess - 1e-9,
            "max_weight": joint_diag["max_weight"] <= settings["max_joint_weight"] + 1e-12,
            "support": not joint_diag["support_failures"],
            "interval_conflicts": not joint_diag.get("interval_conflicts"),
            "pool_conservation": abs(joint_summary["coverage"]["pool_error"]) <= .01,
            "conditional_reconciliation": all(
                abs(value - 1.0) <= 1e-9
                for value in joint_summary["conditional_reconciliation"].values()
            ),
        }
        diagnostics["joint_fit"] = joint_diag
        diagnostics["joint_fit_summary"] = joint_summary
        diagnostics["joint_fit_gates"] = {
            "checks": gate_checks,
            "passed": all(gate_checks.values()),
            "min_global_ess": min_ess,
            "max_weight": settings["max_joint_weight"],
        }
        if joint_result["status"] != "converged" or not all(gate_checks.values()):
            return {
                "status": "failed", "as_of": as_of,
                "error": "joint review fit or review gates failed",
                "diagnostics": diagnostics,
                "model": {"name": diagnostics["engine_code_version"],
                          "seed": settings["seed"]},
            }
        result["expected_payout"] = joint_summary["payout"]
        result["conditionals"] = joint_summary["conditionals"]
        if result["status"] != "ok":
            return {"status": "failed", "as_of": as_of, "error": result["error"],
                    "diagnostics": diagnostics, "model": {
                        "name": diagnostics["engine_code_version"], "seed": settings["seed"]}}
        calibration = []
        for row in result["diagnostics"]["market_residuals"]:
            calibration.append({
                "metric": row["stage"], "team": row["team"],
                "target_probability": row["target_probability"],
                "simulated_probability": row["simulated_probability"],
                "residual": row["residual"], "tolerance": None,
                "sample_count": settings["runs"],
                "effective_sample_size": result["diagnostics"]["global_ess"],
                "quality_status": "diagnostic",
                "sample_metadata": {"publication_gate": False},
            })
        valuations = []
        for entry in state["entries"]:
            gross = result["expected_payout"][entry["team"]]
            price = float(entry["price"])
            valuations.append({
                "entry_id": entry["entry_id"], "team": entry["team"],
                "expected_points": 0.0, "expected_share": gross / state["pot"],
                "expected_payout": round(gross, 2), "auction_price": price,
                "mtm_multiple": round(gross / price, 3) if price else None,
            })
        projections = {
            team: {
                "e_wins_total": result["diagnostics"]["generated_expected_wins"][team],
                "e_remaining_wins": (
                    result["diagnostics"]["generated_expected_wins"][team]
                    - float(state["realized"][team]["wins"])
                ),
                "e_remaining_raw_diff": 0.0, "e_remaining_marquee_addon": 0.0,
                "rating": market_means[team], "p_stage": result["stage_probs"][team],
            } for team in teams
        }
        return {
            "status": "ok", "as_of": as_of, "path_count": settings["runs"],
            "model": {"name": diagnostics["engine_code_version"], "seed": settings["seed"]},
            "review_only": True, "projections": projections, "valuations": valuations,
            "calibration": calibration, "conditional_payouts": result["conditionals"],
            "diagnostics": diagnostics,
        }
    except Exception as error:
        diagnostics["error_type"] = type(error).__name__
        diagnostics["error"] = str(error)
        return {"status": "failed", "as_of": as_of, "error": str(error),
                "diagnostics": diagnostics,
                "model": {"name": diagnostics["engine_code_version"],
                          "seed": settings["seed"]}}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.config) as handle:
        config = json.load(handle)
    with open(args.state) as handle:
        state = json.load(handle)
    snapshot = build_review_snapshot(config, state)
    with open(args.out, "w") as handle:
        json.dump(snapshot, handle, indent=2)
    print(f"v3 review: {snapshot['status']}")
    return 0 if snapshot["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())