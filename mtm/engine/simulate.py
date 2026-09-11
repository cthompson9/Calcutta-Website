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
import random
from dataclasses import dataclass


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
                iters: int = 200) -> dict:
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
    for _ in range(iters):
        w = implied()
        err = max(abs(w[t] - target_remaining_wins[t]) for t in teams) if teams else 0.0
        if err < 1e-4:
            break
        for t in teams:
            n = max(games_by_team[t], 1)
            # d(wins)/d(rating) ~= n * pdf(0)/sd ~= n * 0.4 / sd  -> invert
            step = (target_remaining_wins[t] - w[t]) * lr * (margin_sd / (0.4 * n))
            r[t] += step
        mean = sum(r.values()) / len(r)
        r = {t: v - mean for t, v in r.items()}
    return {"ratings": {t: round(v, 3) for t, v in r.items()},
            "max_abs_win_error": round(err, 4)}


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
                 support_prior_weight: float = 0.01) -> dict:
    """Joint season simulator. Simplified seeding: division winners by wins
    (random tiebreak), wildcards by wins. Playoff games decided by Phi on
    neutral-adjusted ratings (home field to better seed until SB, SB neutral).
    Generated playoff paths are reweighted to normalized elimination-market
    stage marginals before they price payouts. Also returns per-team season
    diff samples for rank-based rubrics.
    """
    rng = random.Random(seed)
    teams = list(ratings.keys())
    stages = ("berth", "divisional", "conference", "sb_berth", "sb_win")
    stage_hits = {t: {"berth": 0, "divisional": 0, "conference": 0,
                      "sb_berth": 0, "sb_win": 0} for t in teams}
    diff_samples: dict[str, list[float]] = {t: [] for t in teams}
    # These are deliberately aggregates, rather than paths.  They make the
    # simulator useful to the mark without turning the snapshot into a dump of
    # (potentially very large) simulated outcomes.
    payout_sum = {t: 0.0 for t in teams}
    payout_sq_sum = {t: 0.0 for t in teams}
    win_sum = {t: 0.0 for t in teams}
    conditional = {i: {o: {"count": 0, "sum": {t: 0.0 for t in teams},
                            "sq": {t: 0.0 for t in teams}, "weight": 0.0,
                            "weight_sq": 0.0}
                     for o in ("home_win", "away_win", "tie")} for i in range(len(remaining))}
    path_gross = []
    path_outcomes = []
    path_wins = []
    hit_indices = {(t, s): [] for t in teams for s in stages}
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
        margin = rng.gauss(mean, margin_sd)
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
            outcomes.append("home_win" if winner == g.home else "away_win")
        for t in teams:
            diff_samples[t].append(diff[t])

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
                path_gross.append(gross)
        if rubric is None or not pot:
            path_gross.append(None)
        path_outcomes.append(outcomes)
        path_wins.append(wins)
        for t in teams:
            for s in stages:
                if path_stage[t][s]:
                    hit_indices[(t, s)].append(run_index)

    weights = proposal_weights
    calibration_residuals = {}
    calibration_converged = True
    recovered_targets = []
    unresolved_targets = []
    if stage_targets and weights:
        calibration_anchor_candidates = {
            s: sorted(
                t for t in teams
                if 0.0 < float(stage_targets[t][s]) < 1.0
            )
            for s in stages
        }
        # Settled contracts are hard constraints, not ordinary calibration
        # targets. Remove impossible paths before fitting open probabilities;
        # later multiplicative updates cannot revive a zero-weight path.
        all_indices = set(range(runs))
        for t in teams:
            for s in stages:
                original_target = float(stage_targets[t][s])
                indices = hit_indices[(t, s)]
                if original_target == 0.0:
                    for i in indices:
                        weights[i] = 0.0
                elif original_target == 1.0:
                    if not indices:
                        raise ValueError(f"no simulated support for settled playoff target {t}:{s}=1")
                    hit_set = set(indices)
                    for i in all_indices - hit_set:
                        weights[i] = 0.0
        if sum(weights) <= 0:
            raise ValueError("settled playoff targets leave no jointly feasible simulated paths")
        scale = runs / sum(weights)
        weights = [w * scale for w in weights]

        for calibration_iteration in range(calibration_iters):
            total_weight = sum(weights)
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
                    target = min(max(original_target, 1e-7), 1 - 1e-7)
                    indices = hit_indices[(t, s)]
                    hit_weight = sum(weights[i] for i in indices)
                    current = hit_weight / total_weight if total_weight else 0.0
                    if not indices or current <= 0:
                        unresolved_targets.append(f"{t}:{s}")
                        raise ValueError(f"no simulated support for positive playoff target {t}:{s}")
                    current = min(max(current, 1e-12), 1 - 1e-12)
                    odds_ratio = (target / (1 - target)) / (current / (1 - current))
                    for i in indices:
                        weights[i] *= odds_ratio
                    total_weight = sum(weights)
            scale = len(weights) / sum(weights)
            weights = [w * scale for w in weights]
            calibration_residuals = {
                f"{t}:{s}": sum(weights[i] for i in hit_indices[(t, s)]) / len(weights)
                - float(stage_targets[t][s])
                for t in teams for s in stages
            }
            playoff_ok = max(
                (abs(value) for value in calibration_residuals.values()),
                default=0.0,
            ) <= calibration_tolerance
            if playoff_ok:
                break
        calibration_converged = (
            max(
                (abs(value) for value in calibration_residuals.values()),
                default=0.0,
            ) <= calibration_tolerance
        )
        recovered_targets = [
            f"{t}:{s}" for t in teams for s in stages
            if 0.0 < float(stage_targets[t][s]) < 1.0
            and any(i in support_indices for i in hit_indices[(t, s)])
            and not any(i not in support_indices for i in hit_indices[(t, s)])
        ]

    weighted_stage_hits = {
        t: {s: sum(weights[i] for i in hit_indices[(t, s)]) for s in stages}
        for t in teams
    }
    for i, weight in enumerate(weights):
        gross = path_gross[i]
        wins = path_wins[i]
        for t in teams:
            win_sum[t] += weight * wins.get(t, 0)
            if gross is not None:
                payout_sum[t] += weight * gross[t]
                payout_sq_sum[t] += weight * gross[t] ** 2
        if gross is not None:
          for gi, outcome in enumerate(path_outcomes[i]):
            bucket = conditional[gi][outcome]
            bucket["count"] += 1
            bucket["weight"] += weight
            bucket["weight_sq"] += weight * weight
            for t in teams:
                bucket["sum"][t] += weight * gross[t]
                bucket["sq"][t] += weight * gross[t] ** 2

    probs = {t: {s: round(h / max(sum(weights), 1), 6) for s, h in d.items()}
             for t, d in weighted_stage_hits.items()}
    effective_sample_size = (
        sum(weights) ** 2 / sum(w * w for w in weights) if weights else 0.0
    )
    out = {"stage_probs": probs, "diff_samples": diff_samples, "runs": runs,
           "effective_sample_size": effective_sample_size,
           "calibration_converged": calibration_converged,
           "calibration_residuals": calibration_residuals,
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
               "calibration_anchor_policy": "rotating_redundant_constraint",
           }}
    if rubric is not None and pot:
        out["payout_sum"] = payout_sum
        out["payout_sq_sum"] = payout_sq_sum
        out["win_sum"] = win_sum
        out["conditional_payouts"] = conditional
    return out
