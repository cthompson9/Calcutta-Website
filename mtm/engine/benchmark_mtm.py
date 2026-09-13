"""Repeatable MTM engine benchmark harness.

This intentionally writes only benchmark measurements.  It accepts a state
path supplied by the caller and never adds fixture or production state to the
repository:

    python benchmark_mtm.py --config ../season-config-2026.json \
      --state /tmp/mtm-state-639.json --runs 20000,40000,60000,80000,100000
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

import run_mtm
import simulate


def _candidate_report(snapshot: dict, runtime: simulate.RuntimeDiagnostics,
                      runs: int) -> dict:
    """Extract audit data from a gate-bypassed diagnostic candidate.

    This is intentionally a benchmark-only report: ``build_snapshot`` keeps
    ``enforce_gate=True`` by default and the returned candidate is never an
    official snapshot.
    """
    diagnostics = snapshot.get("diagnostics", {})
    calibration = diagnostics.get("calibration", {})
    simulation = diagnostics.get("simulation", {})
    history = calibration.get("history", [])
    residuals = calibration.get("worst_residual_targets", [])
    tail = [float(item["max_abs_residual"]) for item in history[-12:]
            if "max_abs_residual" in item]
    market = diagnostics.get("market_calibration", {})
    failed_metrics = [
        {
            "metric": row.get("metric"),
            "team": row.get("team"),
            "residual": row.get("residual"),
            "quality_status": row.get("quality_status"),
        }
        for row in market.get("metrics", [])
        if row.get("quality_status") != "good"
    ]
    gate_would_accept = (
        calibration.get("classification") == "converged"
        and market.get("status") == "good"
    )
    report = {
        "runs": int(runs),
        "status": "candidate",
        "official_gate_would_accept": gate_would_accept,
        "valuations": snapshot.get("valuations", []),
        "team_valuations": snapshot.get("team_valuations", {}),
        "conditional_payouts": snapshot.get("conditional_payouts", {}),
        "ev_summary": {
            "entry_count": len(snapshot.get("valuations", [])),
            "team_count": len(snapshot.get("team_valuations", {})),
            "expected_payout_total": round(sum(
                float(row.get("expected_payout", 0) or 0)
                for row in snapshot.get("valuations", [])
            ), 2),
            "top_entries": sorted(
                (
                    {
                        "entry_id": row.get("entry_id"),
                        "team": row.get("team"),
                        "expected_payout": row.get("expected_payout"),
                        "net_convenience": row.get("net_convenience"),
                    }
                    for row in snapshot.get("valuations", [])
                ),
                key=lambda row: (-(row["expected_payout"] or 0), row["entry_id"] or ""),
            )[:10],
        },
        "calibration": {
            "classification": calibration.get("classification"),
            "converged": calibration.get("converged"),
            "history": history,
            "worst_residual_targets": residuals,
            "max_abs_residual": max(
                (item.get("absolute_residual", 0) for item in residuals),
                default=0.0,
            ),
        },
        "effective_sample_size": (
            simulation.get("effective_sample_size")
            or diagnostics.get("simulation", {}).get("effective_sample_size")
        ),
        "market_calibration": {
            "status": market.get("status"),
            "failed_count": len(failed_metrics),
            "failed_metrics": failed_metrics,
        },
        "stability": {
            "history_tail_range": (
                max(tail) - min(tail) if tail else None
            ),
            "history_tail_monotone": (
                all(a >= b for a, b in zip(tail, tail[1:]))
                if len(tail) > 1 else None
            ),
            "path_count": simulation.get("path_count", runs),
            "conservation_status": simulation.get("conservation_status"),
            "market_calibration_status": market.get("status"),
        },
        "runtime": runtime.snapshot(),
    }
    # Keep the key names explicit for downstream benchmark reports while the
    # grouped sections above remain convenient for humans.
    report["candidate_valuations"] = report["valuations"]
    report["conditional_ev_summaries"] = report["conditional_payouts"]
    report["calibration_history"] = history
    report["worst_residual_targets"] = residuals
    return report


def benchmark(config: dict, state: dict, run_counts=(20000, 40000, 60000,
                                                      80000, 100000)) -> dict:
    """Run identical seeded configurations at each requested path count."""
    results = []
    for count in run_counts:
        trial_config = copy.deepcopy(config)
        trial_config.setdefault("sim", {})["monte_carlo_runs"] = int(count)
        runtime = simulate.RuntimeDiagnostics()
        try:
            # Candidate mode is deliberately explicit and benchmark-only.
            # Production callers use build_snapshot's default gate.
            snapshot = run_mtm._build_snapshot(
                trial_config, state, runtime=runtime, enforce_gate=False)
            result = _candidate_report(snapshot, runtime, count)
        except Exception as error:
            details = runtime.snapshot().get("details", {}).get("monte_carlo", {})
            result = {
                "runs": int(count), "status": "failed", "error": str(error),
                "candidate": {
                    "calibration": details.get("calibration", {}),
                    "support_sampling": details.get("support_sampling", {}),
                    "feasibility": details.get("feasibility", {}),
                },
                "runtime": runtime.snapshot(),
            }
        results.append(result)
    return {"run_counts": [int(v) for v in run_counts], "results": results}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--runs", default="20000,40000,60000,80000,100000")
    parser.add_argument("--out")
    args = parser.parse_args()
    with open(args.config) as handle:
        config = json.load(handle)
    with open(args.state) as handle:
        state = json.load(handle)
    counts = tuple(int(value.strip()) for value in args.runs.split(",") if value.strip())
    result = benchmark(config, state, counts)
    text = json.dumps(result, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n")
    else:
        print(text)
    return 0 if all(row["status"] != "failed" for row in result["results"]) else 1


if __name__ == "__main__":
    sys.exit(main())