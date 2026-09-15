"""Market-calibrated season engine.

Core idea: team ratings are NOT maintained state. Every run re-fits a point-
scale rating vector r (mean 0) so that the analytic expected remaining wins
implied by r over the remaining schedule matches the market's E[remaining wins]
(= ladder E[W] minus realized wins). Because ratings are in POINTS:

    E[margin of i over j at i's home] = r_i - r_j + HFA
    P(i wins)                        = Phi((r_i - r_j + HFA) / margin_sd)

so the same fit prices both future win probability and future point
differential, and the whole thing re-syncs to reality (games played, injuries,
trades) automatically each pull because the market already has.

Outputs per team:
  - e_remaining_pt_diff (raw)  and e_remaining_marquee_diff (the 2x add-on)
  - Monte Carlo playoff-stage probabilities calibrated by path weighting to
    the normalized elimination-market marginals

For rank-based rubrics (e.g. NFL 2024's ranked-differential ladder) use
monte_carlo(...)['diff_samples'] - expectations are not enough there.
"""
from __future__ import annotations

import math
import json
import os
import platform
import random
import signal
import sys
import time
from array import array
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

try:
    import resource
except ImportError:  # pragma: no cover - Windows
    resource = None


_ACTIVE_DIAGNOSTICS = None


class RuntimeDiagnostics:
    """Small, dependency-free run telemetry collector.

    The collector intentionally contains only serializable values.  It is used
    by the CLI as well as by tests and can therefore be included in a snapshot
    even when a later stage fails.
    """

    def __init__(self):
        self.started_wall = time.perf_counter()
        self.started_cpu = time.process_time()
        self.stages = {}
        self.progress = {"stage": "starting", "completed": 0, "total": None}
        self.details = {}

    def record_detail(self, name: str, value):
        """Record JSON-compatible run details for snapshots and failure paths."""
        try:
            json.dumps(value)
        except (TypeError, ValueError) as error:
            raise TypeError(f"runtime detail {name!r} is not serializable") from error
        self.details[name] = value

    def update_details(self, details: dict):
        """Record several JSON-compatible detail fields atomically."""
        for name, value in details.items():
            self.record_detail(name, value)

    @staticmethod
    def _cgroup_value(*paths):
        for path in paths:
            try:
                value = Path(path).read_text().strip()
            except (OSError, ValueError):
                continue
            if value and value != "max":
                try:
                    return int(value)
                except ValueError:
                    continue
        return None

    @staticmethod
    def _cgroup_cpu():
        try:
            text = Path("/sys/fs/cgroup/cpu.max").read_text().split()
            if len(text) == 2 and text[0] != "max":
                return {"quota_us": int(text[0]), "period_us": int(text[1]),
                        "cpus": int(text[0]) / int(text[1])}
        except (OSError, ValueError, ZeroDivisionError):
            pass
        quota = RuntimeDiagnostics._cgroup_value(
            "/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        period = RuntimeDiagnostics._cgroup_value(
            "/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        if quota is not None and period:
            return {"quota_us": quota, "period_us": period,
                    "cpus": quota / period}
        return {}

    def _rss_bytes(self):
        if resource is None:
            return None
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # Linux reports KiB, macOS reports bytes.
        return int(value * 1024 if sys.platform != "darwin" else value)

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        wall = time.perf_counter()
        cpu = time.process_time()
        self.progress["stage"] = name
        completed = False
        try:
            yield
            completed = True
        finally:
            record = self.stages.setdefault(name, {
                "wall_seconds": 0.0, "cpu_seconds": 0.0, "completed": False})
            record["wall_seconds"] += time.perf_counter() - wall
            record["cpu_seconds"] += time.process_time() - cpu
            record["completed"] = completed

    def record_stage(self, name: str, wall_seconds: float, cpu_seconds: float):
        record = self.stages.setdefault(name, {
            "wall_seconds": 0.0, "cpu_seconds": 0.0, "completed": False})
        record["wall_seconds"] += wall_seconds
        record["cpu_seconds"] += cpu_seconds
        record["completed"] = True

    def update_progress(self, stage: str, completed: int, total=None,
                        *, force: bool = False):
        self.progress = {"stage": stage, "completed": int(completed),
                         "total": total}
        # Progress is deliberately sparse; SIGTERM can force a final line.
        if force or completed == total or (total and completed % max(1, total // 20) == 0):
            self.emit_progress()

    def emit_progress(self):
        payload = {"event": "mtm_progress", **self.progress,
                   "wall_seconds": round(time.perf_counter() - self.started_wall, 6)}
        print(json.dumps(payload, separators=(",", ":")),
              file=sys.stderr, flush=True)

    def snapshot(self):
        rss = self._rss_bytes()
        return {
            "wall_seconds": round(time.perf_counter() - self.started_wall, 6),
            "cpu_seconds": round(time.process_time() - self.started_cpu, 6),
            "peak_rss_bytes": rss,
            "python": {"version": platform.python_version(),
                       "implementation": platform.python_implementation()},
            "platform": {"system": platform.system(), "release": platform.release(),
                         "machine": platform.machine()},
            "cpu_count": os.cpu_count(),
            "cgroup": {
                "cpu": self._cgroup_cpu(),
                "memory_limit_bytes": self._cgroup_value(
                    "/sys/fs/cgroup/memory.max",
                    "/sys/fs/cgroup/memory/memory.limit_in_bytes"),
                "memory_current_bytes": self._cgroup_value(
                    "/sys/fs/cgroup/memory.current",
                    "/sys/fs/cgroup/memory/memory.usage_in_bytes"),
            },
            "stages": self.stages,
            "progress": self.progress,
            "details": self.details,
        }


def install_sigterm_diagnostics(runtime: RuntimeDiagnostics):
    """Flush a progress record before the process honors SIGTERM."""
    global _ACTIVE_DIAGNOSTICS
    _ACTIVE_DIAGNOSTICS = runtime

    def _handler(_signum, _frame):
        runtime.emit_progress()
        raise RuntimeError("SIGTERM received")

    signal.signal(signal.SIGTERM, _handler)


def _phi(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


@dataclass
class Game:
    home: str
    away: str
    marquee: bool = False   # outside Sun 1-7pm ET window; diff counts double
    week: int = 0
    event_id: str | None = None


def fit_ratings(target_remaining_wins: dict[str, float],
                remaining: list[Game],
                hfa: float = 1.6,
                margin_sd: float = 13.5,
                lr: float = 0.5,
                 iters: int = 200,
                 diagnostics: RuntimeDiagnostics | None = None) -> dict:
    """Solve r so implied remaining wins match market. Returns ratings + fit error.

    Gradient-free fixed point: nudge each rating by (target - implied) * lr *
    (points per win locally ~ margin_sd / density). Converges fast for NFL-size
    problems; ties contribute 0.5 win-equivalents implicitly via Phi symmetry.
    """
    teams = list(target_remaining_wins.keys())
    r = {t: 0.0 for t in teams}
    games_by_team: dict[str, int] = {t: 0 for t in teams}
    for g in remaining:
        games_by_team[g.home] += 1
        games_by_team[g.away] += 1

    def implied() -> dict[str, float]:
        w = {t: 0.0 for t in teams}
        for g in remaining:
            p_home = _phi((r[g.home] - r[g.away] + hfa) / margin_sd)
            w[g.home] += p_home
            w[g.away] += 1.0 - p_home
        return w

    err = float("inf")
    history = []
    for iteration in range(iters):
        w = implied()
        err = max(abs(w[t] - target_remaining_wins[t]) for t in teams) if teams else 0.0
        history.append({"iteration": iteration + 1, "max_abs_win_error": err})
        if diagnostics is not None:
            diagnostics.update_progress("rating_fit", iteration + 1, iters)
        if err < 1e-4:
            break
        for t in teams:
            n = max(games_by_team[t], 1)
            # d(wins)/d(rating) ~= n * pdf(0)/sd ~= n * 0.4 / sd  -> invert
            step = (target_remaining_wins[t] - w[t]) * lr * (margin_sd / (0.4 * n))
            r[t] += step
        mean = sum(r.values()) / len(r)
        r = {t: v - mean for t, v in r.items()}
    converged = err < 1e-4
    if len(history) >= 4 and history[-1]["max_abs_win_error"] >= history[-2]["max_abs_win_error"]:
        classification = "plateau"
    else:
        classification = "converged" if converged else "incomplete"
    return {
        "ratings": {t: round(v, 3) for t, v in r.items()},
        "max_abs_win_error": round(err, 4),
        "fit_diagnostics": {
            "iterations": len(history), "converged": converged,
            "classification": classification, "history": history,
        },
    }


def fit_joint_review(scenarios, evidence, **settings) -> dict:
    """Delegate the opt-in joint review fit without affecting legacy paths.

    Keeping this small adapter in the simulation module gives callers one
    engine-facing entrypoint while the constrained solver remains isolated
    from the production Monte Carlo implementation.
    """
    import joint_fit

    return joint_fit.fit_joint_weights(scenarios, evidence, **settings)


def expected_remaining_diff(ratings: dict[str, float],
                            remaining: list[Game],
                            hfa: float = 1.6) -> dict[str, dict[str, float]]:
    """Analytic E[remaining raw diff] and E[marquee add-on] per team.
    Adjusted diff for the rubric = raw + marquee_addon (the 2x means the
    marquee margin is counted once more on top of raw). Both are zero-sum
    league-wide, preserving the fixed denominator."""
    out = {t: {"raw": 0.0, "marquee_addon": 0.0} for t in ratings}
    for g in remaining:
        m = ratings[g.home] - ratings[g.away] + hfa   # E[home margin]
        out[g.home]["raw"] += m
        out[g.away]["raw"] -= m
        if g.marquee:
            out[g.home]["marquee_addon"] += m
            out[g.away]["marquee_addon"] -= m
    return {t: {k: round(v, 2) for k, v in d.items()} for t, d in out.items()}


def implied_total_wins(ratings: dict[str, float],
                       remaining: list[Game],
                       realized_wins: dict[str, float],
                       hfa: float = 1.6,
                       margin_sd: float = 13.5) -> dict[str, float]:
    """Feasible fitted win totals implied by the shared rating model."""
    totals = {t: float(realized_wins.get(t, 0.0)) for t in ratings}
    for game in remaining:
        p_home = _phi(
            (ratings[game.home] - ratings[game.away] + hfa) / margin_sd
        )
        totals[game.home] += p_home
        totals[game.away] += 1.0 - p_home
    return totals


def _aggregate_path_statistics(teams, path_outcomes, path_wins, path_gross,
                               weights, *, chunk_size=4096):
    """Compactly reduce simulated paths to the public aggregate statistics.

    The path arrays are deliberately kept as a private boundary: callers get
    the same ordinary dictionaries as the legacy reducer, while the hot loop
    can operate on the compact columnar representation.  Keeping this
    reduction separate also makes it possible to regression-test the
    arithmetic without duplicating the season simulator.
    """
    runs = len(weights)
    # These arrays are the compact path boundary.  Keep the reductions in
    # NumPy rather than walking paths, teams, and outcome buckets in Python.
    # ``chunk_size`` remains part of the API for callers that tune the
    # simulator; the native reductions below operate on the already compact
    # columns, so their summation order is independent of that tuning knob.
    weight_values = np.asarray(weights, dtype=np.float64)
    payout_sum = {t: 0.0 for t in teams}
    payout_sq_sum = {t: 0.0 for t in teams}
    win_sum = {t: 0.0 for t in teams}
    conditional = {
        i: {
            outcome: {
                "count": 0,
                "sum": {t: 0.0 for t in teams},
                "sq": {t: 0.0 for t in teams},
                "weight": 0.0,
                "weight_sq": 0.0,
            }
            for outcome in ("home_win", "away_win", "tie")
        }
        for i in range(len(path_outcomes))
    }

    if path_gross is not None:
        # Weights are multiplied once per compact payout column.  All public
        # sums are converted back to Python floats below, preserving the
        # historical dictionary schema.
        weighted_gross = {}
        weighted_gross_sq = {}
        for t in teams:
            gross_values = np.asarray(path_gross[t], dtype=np.float64)
            weighted = weight_values * gross_values
            weighted_gross[t] = weighted
            weighted_gross_sq[t] = weight_values * np.square(gross_values)
            payout_sum[t] = float(np.sum(weighted, dtype=np.float64))
            payout_sq_sum[t] = float(
                np.sum(weighted_gross_sq[t], dtype=np.float64)
            )

        weights_sq = np.square(weight_values)
        for game_index, outcomes_for_game in enumerate(path_outcomes):
            outcomes = np.asarray(outcomes_for_game, dtype=np.uint8)
            # The simulator currently emits only home/away (0/1), but retain
            # a third slot so the public tie bucket remains explicit.
            counts = np.bincount(outcomes, minlength=3)
            bucket_weights = np.bincount(
                outcomes, weights=weight_values, minlength=3)
            bucket_weight_sq = np.bincount(
                outcomes, weights=weights_sq, minlength=3)
            bucket_sums = {
                t: np.bincount(
                    outcomes, weights=weighted_gross[t], minlength=3)
                for t in teams
            }
            bucket_squares = {
                t: np.bincount(
                    outcomes, weights=weighted_gross_sq[t], minlength=3)
                for t in teams
            }
            for bucket, outcome in enumerate(("home_win", "away_win")):
                target = conditional[game_index][outcome]
                target["count"] = int(counts[bucket])
                target["weight"] = float(bucket_weights[bucket])
                target["weight_sq"] = float(bucket_weight_sq[bucket])
                for t in teams:
                    target["sum"][t] = float(bucket_sums[t][bucket])
                    target["sq"][t] = float(bucket_squares[t][bucket])

    # Win sums are needed even when no rubric/payout column was requested.
    for t in teams:
        win_values = np.asarray(path_wins[t], dtype=np.float64)
        win_sum[t] = float(np.sum(weight_values * win_values, dtype=np.float64))
    return {
        "payout_sum": payout_sum,
        "payout_sq_sum": payout_sq_sum,
        "win_sum": win_sum,
        "conditional_payouts": conditional,
    }


def _calibration_residual_vector(weights, target_indices, target_values):
    """Return native achieved probabilities and residuals for hit columns."""
    weight_values = np.asarray(weights, dtype=np.float64)
    target_values = np.asarray(target_values, dtype=np.float64)
    achieved = np.asarray(
        [np.sum(weight_values[indices], dtype=np.float64)
         for indices in target_indices],
        dtype=np.float64,
    ) / len(weight_values)
    return achieved, achieved - target_values


def _apply_calibration_hit_update(weights, indices, odds_ratio,
                                  total_weight):
    """Scale a hit subset with one native indexed operation."""
    old_hit_weight = float(np.sum(weights[indices], dtype=np.float64))
    weights[indices] *= odds_ratio
    total_weight += float(np.sum(weights[indices], dtype=np.float64))
    return total_weight - old_hit_weight


def monte_carlo(ratings: dict[str, float],
                remaining: list[Game],
                realized_wins: dict[str, float],
                divisions: dict[str, list[str]],
                hfa: float = 1.6,
                margin_sd: float = 13.5,
                runs: int = 20000,
                seed: int = 20260829,
                rubric: dict | None = None,
                pot: float = 0.0,
                 realized_stats: dict | None = None,
                 stage_targets: dict[str, dict[str, float]] | None = None,
                 calibration_tolerance: float = 0.03,
                 calibration_iters: int = 500,
                 support_runs_per_team: int = 0,
                 support_prior_weight: float = 0.01,
                 diagnostics: RuntimeDiagnostics | None = None,
                  aggregation_chunk_size: int = 4096,
                  return_path_library: bool = False,
                  review_proposal=None,
                  return_review_arrays: bool = False) -> dict:
    """Joint season simulator. Simplified seeding: division winners by wins
    (random tiebreak), wildcards by wins. Playoff games decided by Phi on
    neutral-adjusted ratings (home field to better seed until SB, SB neutral).
    Generated playoff paths are reweighted to normalized elimination-market
    stage marginals before they price payouts. Also returns per-team season
    diff samples for rank-based rubrics.
    """
    if review_proposal is not None and support_runs_per_team:
        raise ValueError("Review mixture cannot combine with reflected support paths")
    rng = random.Random(seed)
    teams = list(ratings.keys())
    stages = ("berth", "divisional", "conference", "sb_berth", "sb_win")
    stage_hits = {t: {"berth": 0, "divisional": 0, "conference": 0,
                      "sb_berth": 0, "sb_win": 0} for t in teams}
    # Arrays keep the large path library compact during a 100k-path run.  The
    # public result is converted back to ordinary lists below.
    diff_samples: dict[str, array] = {t: array("d") for t in teams}
    # These are deliberately aggregates, rather than paths.  They make the
    # simulator useful to the mark without turning the snapshot into a dump of
    # (potentially very large) simulated outcomes.
    # Outcomes are encoded as 0=home, 1=away, one byte per game/path.  Gross
    # payout arrays are columnar (one array per team), avoiding R*G*T dicts.
    path_outcomes = [bytearray() for _ in remaining]
    path_wins = {t: array("H") for t in teams}
    path_gross = ({t: array("d") for t in teams}
                  if rubric is not None and pot else None)
    hit_indices = {(t, s): array("I") for t in teams for s in stages}
    eligible_support_teams = sorted([
        t for t in teams
        if stage_targets and any(
            0.0 < float(stage_targets[t][s]) < 1.0 for s in stages
        )
    ])
    support_budget = min(
        runs, support_runs_per_team * len(eligible_support_teams)
    )
    ordinary_runs = runs - support_budget
    support_teams = []
    regular_support_teams = set()
    support_indices = set()
    proposal_weights = []
    current_support_team: str | None = None

    conf_of = {}
    for conf, divs in divisions.items():
        pass  # divisions arg shape: {"AFC East": [...], ...}; conf from name prefix
    for div, ts in divisions.items():
        conf = div.split()[0]
        for t in ts:
            conf_of[t] = conf

    def play(a: str, b: str, home: str | None,
             allow_support: bool = False) -> tuple[str, float]:
        adv = hfa if home == a else (-hfa if home == b else 0.0)
        mean = ratings[a] - ratings[b] + adv
        margin = (review_proposal.sample_margin(
            a, b, mean, margin_sd, playoff=allow_support, rng=rng)
            if review_proposal is not None else rng.gauss(mean, margin_sd))
        # Proposal strata preserve feasible joint paths while ensuring that
        # long shots can appear in the finite path library. Reflecting the
        # sampled margin keeps magnitudes plausible; it never inserts a team
        # into a game or bracket it could not reach by winning its games.
        if allow_support and current_support_team == a:
            margin = abs(margin)
        elif allow_support and current_support_team == b:
            margin = -max(abs(margin), 1e-12)
        return (a, margin) if margin >= 0 else (b, -margin)

    for run_index in range(runs):
        if review_proposal is not None:
            review_proposal.start_path(rng)
        if diagnostics is not None:
            diagnostics.update_progress("monte_carlo", run_index + 1, runs)
        if run_index == ordinary_runs and support_budget:
            ordinary_denominator = max(ordinary_runs, 1)
            support_deficits = {
                t: max(
                    float(stage_targets[t][s])
                    - len(hit_indices[(t, s)]) / ordinary_denominator
                    for s in stages
                    if 0.0 < float(stage_targets[t][s]) < 1.0
                )
                for t in eligible_support_teams
            }
            support_teams = [
                t for t, deficit in sorted(
                    support_deficits.items(),
                    key=lambda item: (-item[1], item[0]),
                )
            ]
            regular_support_teams = {
                t for t in support_teams
                if any(
                    0.0 < float(stage_targets[t][s]) < 1.0
                    and not hit_indices[(t, s)]
                    for s in stages
                )
            }
        support_offset = run_index - ordinary_runs
        current_support_team = (
            support_teams[support_offset % len(support_teams)]
            if support_offset >= 0 and support_teams else None
        )
        if current_support_team is not None:
            support_indices.add(run_index)
        proposal_weights.append(
            support_prior_weight if current_support_team is not None else 1.0
        )
        wins = {t: (v.get("wins", 0) if isinstance(v, dict) else v)
                for t, v in (realized_stats or realized_wins).items()}
        ties = {t: (v.get("ties", 0) if isinstance(v, dict) else 0)
                for t, v in (realized_stats or {}).items()}
        realized_diff = {t: (v.get("adj_pt_diff", 0) if isinstance(v, dict) else 0)
                         for t, v in (realized_stats or {}).items()}
        diff = {t: 0.0 for t in teams}
        outcomes = []
        for gi, g in enumerate(remaining):
            winner, margin = play(
                g.home, g.away, g.home,
                allow_support=current_support_team in regular_support_teams,
            )
            wins[winner] = wins.get(winner, 0) + 1
            sgn = 1 if winner == g.home else -1
            adjusted_margin = margin * (2 if g.marquee else 1)
            diff[g.home] += sgn * adjusted_margin
            diff[g.away] -= sgn * adjusted_margin
            outcome_code = 0 if winner == g.home else 1
            path_outcomes[gi].append(outcome_code)
        for t in teams:
            diff_samples[t].append(diff[t])
            path_wins[t].append(min(wins.get(t, 0), 65535))

        # seeding per conference
        path_stage = {t: {s: 0 for s in stage_hits[t]} for t in teams}
        for conf in {c for c in conf_of.values()}:
            div_winners = []
            for div, ts in divisions.items():
                if not div.startswith(conf):
                    continue
                best = max(ts, key=lambda t: (wins.get(t, 0), rng.random()))
                div_winners.append(best)
            others = [t for t in teams if conf_of[t] == conf and t not in div_winners]
            wildcards = sorted(others, key=lambda t: (wins.get(t, 0), rng.random()),
                               reverse=True)[:3]
            div_winners.sort(key=lambda t: (wins.get(t, 0), rng.random()), reverse=True)
            seeds = div_winners + wildcards          # 1..7
            for t in seeds:
                stage_hits[t]["berth"] += 1
                path_stage[t]["berth"] = 1
            # wild card round: 2v7 3v6 4v5, 1 bye
            wc_winners = [seeds[0]]
            for hi, lo in [(1, 6), (2, 5), (3, 4)]:
                w, _ = play(seeds[hi], seeds[lo], seeds[hi], allow_support=True)
                wc_winners.append(w)
            for t in wc_winners:
                stage_hits[t]["divisional"] += 1
                path_stage[t]["divisional"] = 1
            wc_winners.sort(key=lambda t: seeds.index(t))
            w1, _ = play(wc_winners[0], wc_winners[3], wc_winners[0], allow_support=True)
            w2, _ = play(wc_winners[1], wc_winners[2], wc_winners[1], allow_support=True)
            finalists = sorted([w1, w2], key=lambda t: seeds.index(t))
            for t in finalists:
                stage_hits[t]["conference"] += 1
                path_stage[t]["conference"] = 1
            cw, _ = play(finalists[0], finalists[1], finalists[0], allow_support=True)
            stage_hits[cw]["sb_berth"] += 1
            path_stage[cw]["sb_berth"] = 1
            if conf == sorted({c for c in conf_of.values()})[0]:
                sb_a = cw
            else:
                sb_b = cw
        sb_winner, _ = play(sb_a, sb_b, None, allow_support=True)
        stage_hits[sb_winner]["sb_win"] += 1
        path_stage[sb_winner]["sb_win"] = 1

        if rubric is not None and pot:
            points = {}
            for t in teams:
                p = float(rubric["banked"])
                p += rubric["per_win"] * wins.get(t, 0)
                p += rubric.get("per_tie", 0) * ties.get(t, 0)
                p += rubric["per_pt_diff"] * (realized_diff.get(t, 0) + diff[t])
                for s in stages:
                    p += rubric["bonuses"][s] * path_stage[t][s]
                points[t] = p
            total = sum(points.values())
            if total > 0:
                gross = {t: pot * points[t] / total for t in teams}
                for t in teams:
                    path_gross[t].append(gross[t])
        elif path_gross is not None:
            for t in teams:
                path_gross[t].append(0.0)
        for t in teams:
            for s in stages:
                if path_stage[t][s]:
                    hit_indices[(t, s)].append(run_index)

        if review_proposal is not None:
            proposal_weights[-1] = review_proposal.path_weight()

    weights = np.asarray(proposal_weights, dtype=np.float64)
    calibration_residuals = {}
    calibration_converged = True
    recovered_targets = []
    unresolved_targets = []
    calibration_history = []
    calibration_counters = {
        "iterations": 0, "target_count": 0, "positive_targets": 0,
        "settled_zero_targets": 0, "settled_one_targets": 0,
        "weight_updates": 0, "unsupported_targets": 0,
        "zero_weight_paths": 0, "feasible_path_count": 0,
        "targets_with_support": 0, "targets_without_support": 0,
    }
    calibration_classification = "not_requested"
    calibration_started_wall = time.perf_counter()
    calibration_started_cpu = time.process_time()

    def _sample_calibration_history(record: dict, *, force: bool = False):
        """Keep first/periodic/last convergence records, never the full trace."""
        limit = 40
        iteration = int(record["iteration"])
        interval = max(1, calibration_iters // (limit - 2))
        if force or iteration == 1 or iteration % interval == 0:
            if calibration_history and calibration_history[-1]["iteration"] == iteration:
                calibration_history[-1] = record
            else:
                calibration_history.append(record)
            # A very large configured iteration count can still produce more
            # than the intended sparse trace; retain the first and newest
            # records while pruning only the middle.
            while len(calibration_history) > limit:
                del calibration_history[1]

    def _runtime_calibration_details():
        target_keys = (
            [(t, s) for t in teams for s in stages]
            if stage_targets else []
        )
        target_support = {
            f"{t}:{s}": {
                "target": float(stage_targets[t][s]),
                "hit_count": len(hit_indices[(t, s)]),
                "support_path_count": sum(
                    i in support_indices for i in hit_indices[(t, s)]
                ),
                "ordinary_path_count": sum(
                    i not in support_indices for i in hit_indices[(t, s)]
                ),
            }
            for t, s in target_keys
        }
        worst = sorted(
            (
                {
                    "target": key,
                    "residual": float(value),
                    "absolute_residual": abs(float(value)),
                    "estimated_probability": (
                        float(stage_targets[key.rsplit(":", 1)[0]][
                            key.rsplit(":", 1)[1]
                        ]) + float(value)
                    ),
                }
                for key, value in calibration_residuals.items()
            ),
            key=lambda item: (-item["absolute_residual"], item["target"]),
        )[:10]
        details = {
            "calibration": {
                "classification": calibration_classification,
                "history": list(calibration_history),
                "counters": dict(calibration_counters),
                "worst_residual_targets": worst,
            },
            "support_sampling": {
                "enabled": bool(support_indices),
                "reserved_path_count": support_budget,
                "path_count": len(support_indices),
                "runs_per_team": support_runs_per_team,
                "prior_weight": support_prior_weight,
                "targeted_teams": list(support_teams),
                "regular_season_targeted_teams": sorted(regular_support_teams),
                "recovered_targets": list(recovered_targets),
                "unresolved_targets": list(unresolved_targets),
                "target_support": target_support,
                "calibration_anchor_policy": "rotating_redundant_constraint",
            },
            "feasibility": {
                "simulated_path_count": runs,
                "feasible_path_count": calibration_counters[
                    "feasible_path_count"
                ],
                "zero_weight_paths": calibration_counters["zero_weight_paths"],
                "positive_target_count": calibration_counters["positive_targets"],
                "positive_targets_with_support": calibration_counters[
                    "targets_with_support"
                ],
                "positive_targets_without_support": calibration_counters[
                    "targets_without_support"
                ],
                "stage_inventory": {
                    s: sum(len(hit_indices[(t, s)]) for t in teams) / max(runs, 1)
                    for s in stages
                },
                "stage_inventory_target": {
                    s: sum(float(stage_targets[t][s]) for t in teams)
                    if stage_targets else None
                    for s in stages
                },
                "stage_inventory_residual": {
                    s: sum(
                        float(value) for key, value in calibration_residuals.items()
                        if key.endswith(f":{s}")
                    )
                    for s in stages
                },
            },
        }
        if diagnostics is not None:
            diagnostics.update_details({"monte_carlo": details})
        return details

    # Publish an initial record as soon as path support is known.  This makes
    # failures during calibration (and SIGTERM) retain useful evidence.
    _runtime_calibration_details()

    if stage_targets and len(weights):
        calibration_anchor_candidates = {
            s: sorted(
                t for t in teams
                if 0.0 < float(stage_targets[t][s]) < 1.0
            )
            for s in stages
        }
        # Every simulated path has the fixed inventory for a stage (14 berths,
        # 8 divisional places, ...).  Once settled targets are filtered, the
        # remaining positive target in each stage is mathematically redundant:
        # the legacy deterministic rotating-anchor schedule is retained.
        target_keys = [(t, s) for t in teams for s in stages]
        target_values = np.asarray(
            [float(stage_targets[t][s]) for t, s in target_keys],
            dtype=np.float64,
        )
        target_indices = [
            np.asarray(hit_indices[key], dtype=np.intp) for key in target_keys
        ]
        target_index_by_key = dict(zip(target_keys, range(len(target_keys))))
        calibration_counters["target_count"] = len(target_keys)
        calibration_counters["positive_targets"] = sum(
            0.0 < float(stage_targets[t][s]) < 1.0
            for t, s in target_keys)
        calibration_counters["band_skipped_updates"] = 0
        calibration_counters["band_projected_updates"] = 0
        # Keep projections strictly inside the public tolerance boundary so
        # six-decimal published probabilities cannot round onto the gate.
        calibration_band_margin = min(
            1e-4,
            max(1e-6, calibration_tolerance * 1e-3),
        )
        calibration_counters["tolerance_band_margin"] = calibration_band_margin
        calibration_counters["settled_zero_targets"] = sum(
            float(stage_targets[t][s]) == 0.0 for t, s in target_keys)
        calibration_counters["settled_one_targets"] = sum(
            float(stage_targets[t][s]) == 1.0 for t, s in target_keys)
        # Settled contracts are hard constraints, not ordinary calibration
        # targets. Remove impossible paths before fitting open probabilities;
        # later multiplicative updates cannot revive a zero-weight path.
        settled_one_mask = np.ones(runs, dtype=bool)
        for key, original_target, indices in zip(
                target_keys, target_values, target_indices):
            t, s = key
            if original_target == 0.0:
                weights[indices] = 0.0
            elif original_target == 1.0:
                if not len(indices):
                    unresolved_targets.append(f"{t}:{s}")
                    _runtime_calibration_details()
                    raise ValueError(
                        f"no simulated support for settled playoff target {t}:{s}=1"
                    )
                allowed = np.zeros(runs, dtype=bool)
                allowed[indices] = True
                settled_one_mask &= allowed
        weights[~settled_one_mask] = 0.0
        if np.sum(weights, dtype=np.float64) <= 0:
            _runtime_calibration_details()
            raise ValueError("settled playoff targets leave no jointly feasible simulated paths")
        scale = runs / float(np.sum(weights, dtype=np.float64))
        weights *= scale
        calibration_counters["zero_weight_paths"] = int(np.count_nonzero(weights == 0.0))
        calibration_counters["feasible_path_count"] = int(
            np.count_nonzero(weights > 0.0))
        calibration_counters["targets_with_support"] = sum(
            bool(hit_indices[key]) for key in target_keys
            if 0.0 < float(stage_targets[key[0]][key[1]]) < 1.0)
        calibration_counters["targets_without_support"] = (
            calibration_counters["positive_targets"]
            - calibration_counters["targets_with_support"])
        _runtime_calibration_details()

        total_weight = float(np.sum(weights, dtype=np.float64))

        for calibration_iteration in range(calibration_iters):
            for t in teams:
                for s in stages:
                    original_target = float(stage_targets[t][s])
                    anchors = calibration_anchor_candidates[s]
                    rotating_anchor = (
                        anchors[calibration_iteration % len(anchors)]
                        if anchors else None
                    )
                    if original_target in (0.0, 1.0) or t == rotating_anchor:
                        continue
                    # Project onto the open tolerance band rather than onto
                    # an exact point.  The tiny interior margin keeps
                    # floating-point roundoff from landing on the gate edge.
                    lower_band = max(
                        1e-7,
                        original_target - calibration_tolerance
                        + calibration_band_margin,
                    )
                    upper_band = min(
                        1 - 1e-7,
                        original_target + calibration_tolerance
                        - calibration_band_margin,
                    )
                    indices = target_indices[target_index_by_key[(t, s)]]
                    # Preserve the legacy per-target hit sum.  Only the
                    # redundant full-array total is eliminated below.
                    hit_weight = float(np.sum(weights[indices], dtype=np.float64))
                    current = hit_weight / total_weight if total_weight else 0.0
                    if not len(indices) or current <= 0:
                        unresolved_targets.append(f"{t}:{s}")
                        calibration_counters["unsupported_targets"] += 1
                        _runtime_calibration_details()
                        raise ValueError(f"no simulated support for positive playoff target {t}:{s}")
                    current = min(max(current, 1e-12), 1 - 1e-12)
                    if lower_band <= current <= upper_band:
                        calibration_counters["band_skipped_updates"] += 1
                        continue
                    projected_target = (
                        lower_band if current < lower_band else upper_band
                    )
                    calibration_counters["band_projected_updates"] += 1
                    odds_ratio = (
                        (projected_target / (1 - projected_target))
                        / (current / (1 - current))
                    )
                    total_weight = _apply_calibration_hit_update(
                        weights, indices, odds_ratio, total_weight)
                    calibration_counters["weight_updates"] += len(indices)
            # One exact pass preserves the legacy normalization denominator;
            # the removed work is the redundant full pass after every hit set.
            total_weight = float(np.sum(weights, dtype=np.float64))
            scale = len(weights) / total_weight
            weights *= scale
            total_weight = float(len(weights))
            achieved, residual_values = _calibration_residual_vector(
                weights, target_indices, target_values)
            calibration_residuals = {
                f"{t}:{s}": float(value)
                for (t, s), value in zip(target_keys, residual_values)
            }
            max_residual = max(
                (abs(value) for value in calibration_residuals.values()), default=0.0)
            rms_residual = math.sqrt(
                float(np.sum(np.square(residual_values), dtype=np.float64))
                / max(len(residual_values), 1))
            history_record = {
                "iteration": calibration_iteration + 1,
                "max_abs_residual": max_residual,
                "rms_residual": rms_residual,
            }
            _sample_calibration_history(history_record)
            calibration_counters["iterations"] = calibration_iteration + 1
            _runtime_calibration_details()
            playoff_ok = max(
                (abs(value) for value in calibration_residuals.values()),
                default=0.0,
            ) <= calibration_tolerance
            if playoff_ok:
                break
        if calibration_history and (
            calibration_history[-1]["iteration"] != calibration_counters["iterations"]
        ):
            _sample_calibration_history(history_record, force=True)
        calibration_converged = (
            max(
                (abs(value) for value in calibration_residuals.values()),
                default=0.0,
            ) <= calibration_tolerance
        )
        if calibration_converged:
            calibration_classification = "converged"
        elif len(calibration_history) >= 4:
            # Use a wider sampled window than the four-record legacy check:
            # the bounded trace is periodic by construction, so a short tail
            # can hide the alternating closure passes.
            recent = [h["max_abs_residual"] for h in calibration_history[-12:]]
            deltas = [recent[i] - recent[i - 1] for i in range(1, 4)]
            alternating = (
                sum(
                    deltas[i] * deltas[i + 1] < 0
                    for i in range(len(deltas) - 1)
                ) >= max(3, len(deltas) // 2)
                and max(recent) - min(recent) > max(
                    calibration_tolerance * .1, 1e-9
                )
            )
            if alternating:
                calibration_classification = "oscillation"
            elif max(recent) - min(recent) <= max(calibration_tolerance * .05, 1e-9):
                calibration_classification = "plateau"
            else:
                calibration_classification = "incomplete"
        else:
            calibration_classification = "incomplete"
        calibration_counters["settled_zero_targets"] = sum(
            float(stage_targets[t][s]) == 0.0 for t, s in target_keys)
        calibration_counters["settled_one_targets"] = sum(
            float(stage_targets[t][s]) == 1.0 for t, s in target_keys)
        recovered_targets = [
            f"{t}:{s}" for t in teams for s in stages
            if 0.0 < float(stage_targets[t][s]) < 1.0
            and any(i in support_indices for i in hit_indices[(t, s)])
            and not any(i not in support_indices for i in hit_indices[(t, s)])
        ]
        _runtime_calibration_details()
    if diagnostics is not None:
        diagnostics.record_stage(
            "calibration", time.perf_counter() - calibration_started_wall,
            time.process_time() - calibration_started_cpu)

    aggregation_started_wall = time.perf_counter()
    aggregation_started_cpu = time.process_time()
    weighted_stage_hits = {
        t: {
            s: float(np.sum(
                weights[np.asarray(hit_indices[(t, s)], dtype=np.intp)],
                dtype=np.float64,
            ))
            for s in stages
        }
        for t in teams
    }
    aggregates = _aggregate_path_statistics(
        teams, path_outcomes, path_wins, path_gross, weights,
        chunk_size=aggregation_chunk_size)
    payout_sum = aggregates["payout_sum"]
    payout_sq_sum = aggregates["payout_sq_sum"]
    win_sum = aggregates["win_sum"]
    conditional = aggregates["conditional_payouts"]
    if diagnostics is not None:
        diagnostics.record_stage(
            "aggregation", time.perf_counter() - aggregation_started_wall,
            time.process_time() - aggregation_started_cpu)

    total_weight = float(np.sum(weights, dtype=np.float64))
    probs = {t: {s: round(h / max(total_weight, 1), 6) for s, h in d.items()}
             for t, d in weighted_stage_hits.items()}
    effective_sample_size = (
        total_weight ** 2 / float(np.sum(np.square(weights), dtype=np.float64))
        if len(weights) else 0.0
    )
    # ``weights`` are intentionally kept on the historical count scale
    # (their sum is the number of paths), so expose max weight only after the
    # same final normalization used by all aggregate consumers.
    normalized_weights = (
        weights / total_weight if total_weight > 0 else np.asarray([], dtype=np.float64)
    )
    max_weight = (
        float(np.max(normalized_weights)) if len(normalized_weights) else 0.0
    )
    runtime_details = _runtime_calibration_details()
    out = {"stage_probs": probs,
           "diff_samples": {t: list(values) for t, values in diff_samples.items()},
           "runs": runs,
           "effective_sample_size": effective_sample_size,
           "max_weight": max_weight,
           "weight_diagnostics": {
               "effective_sample_size": effective_sample_size,
               "max_weight": max_weight,
           },
           "calibration_converged": calibration_converged,
           "calibration_residuals": calibration_residuals,
           "calibration_diagnostics": {
               "classification": calibration_classification,
               "converged": calibration_converged,
               "history": calibration_history,
               "counters": calibration_counters,
                "worst_residual_targets": runtime_details["calibration"][
                    "worst_residual_targets"
                ],
                "support_evidence": runtime_details["support_sampling"][
                    "target_support"
                ],
                "feasibility": runtime_details["feasibility"],
           },
           "support_sampling": {
               "enabled": bool(support_indices),
               "reserved_path_count": support_budget,
               "path_count": len(support_indices),
               "runs_per_team": support_runs_per_team,
               "prior_weight": support_prior_weight,
               "targeted_teams": support_teams,
               "regular_season_targeted_teams": sorted(regular_support_teams),
               "recovered_targets": recovered_targets,
               "unresolved_targets": unresolved_targets,
                "target_support": runtime_details["support_sampling"][
                    "target_support"
                ],
                "calibration_anchor_policy": "rotating_redundant_constraint",
           }}
    if rubric is not None and pot:
        out["payout_sum"] = payout_sum
        out["payout_sq_sum"] = payout_sq_sum
        out["win_sum"] = win_sum
        out["conditional_payouts"] = conditional
    if review_proposal is not None:
        out["review_proposal"] = review_proposal.diagnostics()
    if return_review_arrays:
        out["_review_arrays"] = {
            "weights": normalized_weights, "gross": path_gross,
            "wins": path_wins, "hits": hit_indices,
            "outcomes": path_outcomes, "prior_weights": proposal_weights,
        }
    if return_path_library:
        # Keep this opt-in: the canonical snapshot intentionally does not
        # retain one dictionary per simulated path.  Review callers use this
        # compact library to fit a second set of market constraints without
        # generating outcomes that were absent from the simulator.
        out["path_library"] = [
            {
                "id": f"path-{i:08d}",
                "prior_weight": float(proposal_weights[i]),
                "wins": {t: int(path_wins[t][i]) for t in teams},
                "outcomes": {
                    str(gi): ("home_win" if path_outcomes[gi][i] == 0 else "away_win")
                    for gi in range(len(path_outcomes))
                },
                "advancement": {
                    t: {s: int(i in hit_indices[(t, s)]) for s in stages}
                    for t in teams
                },
                "payout": (
                    {t: float(path_gross[t][i]) for t in teams}
                    if path_gross is not None else {}
                ),
                "legal": True,
            }
            for i in range(runs)
        ]
    return out
