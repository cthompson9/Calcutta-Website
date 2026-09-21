"""Playoff reach probabilities from Kalshi Stage of Elimination markets.

Per team, elimination outcomes are mutually exclusive and exhaustive:
    {no_playoffs, wild_card, divisional, conference, sb_loss, sb_win}
Cumulative reach probability = suffix sum:
    P(berth)      = P(elim at WC or later)
    P(divisional) = P(elim at DIV or later)   # i.e. survived/skipped WC round
    P(conference) = P(elim at CONF or later)
    P(sb_berth)   = P(sb_loss) + P(sb_win)
    P(sb_win)     = P(sb_win)

Raw prices use bid + 1c (spreads are wide on these). League-wide sums must
equal exact inventory: 14 / 8 / 4 / 2 / 1. Normalization is the POWER METHOD:
find alpha such that sum_i p_i^alpha = target. Non-linear on purpose - it
shrinks longshots proportionally more, correcting favorite-longshot bias.
Per-team monotonicity is then enforced and stages renormalized once more.
"""
from __future__ import annotations

STAGES = ["berth", "divisional", "conference", "sb_berth", "sb_win"]
ELIM_ORDER = ["no_playoffs", "wild_card", "divisional", "conference", "sb_loss", "sb_win"]


def reach_from_elimination(elim_probs: dict[str, float],
                           *, fixed: dict[str, bool] | None = None) -> dict[str, float]:
    """Convert exclusive reference marks to cumulative reach probabilities.

    ``fixed`` is deliberately metadata rather than inferred from a numeric
    endpoint: an active quote of 0 or 1 is still an adjustable observation.
    """
    p = {k: max(0.0, min(1.0, float(elim_probs.get(k, 0.0)))) for k in ELIM_ORDER}
    return {
        "berth": p["wild_card"] + p["divisional"] + p["conference"] + p["sb_loss"] + p["sb_win"],
        "divisional": p["divisional"] + p["conference"] + p["sb_loss"] + p["sb_win"],
        "conference": p["conference"] + p["sb_loss"] + p["sb_win"],
        "sb_berth": p["sb_loss"] + p["sb_win"],
        "sb_win": p["sb_win"],
    }


def _power_alpha(probs: list[float], target: float,
                 lo: float = 1e-4, hi: float = 1e9, iters: int = 200) -> float:
    """Bisect alpha so sum(p^alpha) = target. p^alpha is decreasing in alpha
    for p in (0,1), so f(alpha) = sum(p^alpha) - target is decreasing."""
    if target < -1e-12 or target > len(probs) + 1e-12:
        raise ValueError(f"power-normalization target {target} is infeasible for {len(probs)} values")
    if not probs:
        if abs(target) <= 1e-12:
            return 1.0
        raise ValueError("power-normalization has no adjustable values")
    clean = [min(max(float(p), 1e-12), 1 - 1e-9) for p in probs]

    def f(a: float) -> float:
        return sum(p ** a for p in clean) - target

    if abs(f(lo)) <= 1e-12:
        return lo
    if f(lo) < 0 or f(hi) > 0:
        raise ValueError(f"power-normalization target {target} is infeasible")
    a, b = lo, hi
    for _ in range(iters):
        m = (a + b) / 2
        if f(m) > 0:
            a = m
        else:
            b = m
    return (a + b) / 2


def normalize_stage(team_probs: dict[str, float], target: float) -> tuple[dict[str, float], float]:
    teams = list(team_probs.keys())
    raw = [team_probs[t] for t in teams]
    alpha = _power_alpha(raw, target)
    fixed = {t: min(max(float(team_probs[t]), 1e-12), 1 - 1e-9) ** alpha for t in teams}
    return fixed, alpha


def normalize_exclusive(outcomes: dict[str, float],
                        fixed: dict[str, bool] | None = None,
                        *, tolerance: float = 1e-8) -> dict:
    """Power-normalize one team's six mutually-exclusive outcomes.

    Fixed facts are never moved.  Numeric endpoints without ``fixed=True``
    remain active and receive an internal epsilon during exponent solving.
    """
    fixed = fixed or {}
    values = {name: float(outcomes.get(name, 0.0)) for name in ELIM_ORDER}
    fixed_sum = sum(values[name] for name in ELIM_ORDER if fixed.get(name, False))
    adjustable = [name for name in ELIM_ORDER if not fixed.get(name, False)]
    target = 1.0 - fixed_sum
    if target < -tolerance or target > len(adjustable) + tolerance:
        raise ValueError("fixed elimination facts are infeasible")
    alpha = 1.0
    if adjustable:
        if target <= tolerance:
            for name in adjustable:
                values[name] = 0.0
        else:
            normalized, alpha = normalize_stage(
                {name: min(max(values[name], 1e-12), 1 - 1e-12) for name in adjustable},
                target,
            )
            values.update(normalized)
    elif abs(target) > tolerance:
        raise ValueError("fixed elimination facts do not sum to one")
    residual = sum(values.values()) - 1.0
    if abs(residual) > tolerance:
        raise ValueError(f"exclusive normalization residual {residual:.12g}")
    return {"probabilities": values, "alpha": alpha, "residual": residual}


def normalize_all(reach_by_team: dict[str, dict[str, float]],
                  targets: dict[str, float],
                  rounds: int = 100,
                  *,
                  fixed: dict[str, dict[str, bool]] | None = None,
                  method_version: str = "reference-mark-power-v1",
                  tolerance: float = 1e-8) -> dict:
    """reach_by_team: team -> {stage: raw prob}. Returns normalized probs,
    per-stage alphas, and residuals (post-monotone-clamp sum error).
    Teams already eliminated/clinched should arrive as exact 0/1 and are
    held fixed (their contracts have settled; only open probs get scaled)."""
    teams = list(reach_by_team.keys())
    fixed = fixed or {}
    probs = {t: {s: float(reach_by_team[t].get(s, 0.0)) for s in STAGES}
             for t in teams}
    fixed_stage = {t: {s: bool(fixed.get(t, {}).get(s, False)) for s in STAGES}
                   for t in teams}
    alphas: dict[str, float] = {}
    stage_residuals = {s: float("inf") for s in STAGES}
    monotonicity_residual = float("inf")
    converged = False
    for iteration in range(1, rounds + 1):
        for stage in STAGES:
            open_teams = [t for t in teams if not fixed_stage[t][stage]]
            settled_sum = sum(probs[t][stage] for t in teams if fixed_stage[t][stage])
            remaining_target = targets[stage] - settled_sum
            if remaining_target < -tolerance or remaining_target > len(open_teams) + tolerance:
                raise ValueError(f"fixed facts are infeasible for stage {stage}")
            if open_teams:
                if remaining_target <= tolerance:
                    for t in open_teams:
                        probs[t][stage] = 0.0
                else:
                    sub = {t: probs[t][stage] for t in open_teams}
                    fixed, alpha = normalize_stage(sub, remaining_target)
                    for t in open_teams:
                        probs[t][stage] = fixed[t]
                    alphas[stage] = alphas.get(stage, 1.0) * alpha
        for t in teams:
            prev = 1.0
            for stage in STAGES:
                if not fixed_stage[t][stage]:
                    probs[t][stage] = min(probs[t][stage], prev)
                elif probs[t][stage] > prev + tolerance:
                    raise ValueError(f"fixed facts violate reach monotonicity for {t}")
                prev = probs[t][stage]
        stage_residuals = {s: sum(probs[t][s] for t in teams) - targets[s] for s in STAGES}
        monotonicity_residual = max(
            (max(0.0, probs[t][stage] - probs[t][STAGES[i - 1]])
             for t in teams for i, stage in enumerate(STAGES) if i),
            default=0.0,
        )
        if max(abs(v) for v in stage_residuals.values()) <= tolerance and monotonicity_residual <= tolerance:
            converged = True
            break
    if not converged:
        raise ValueError(
            f"playoff power normalization did not converge after {rounds} iterations: "
            f"stage_residuals={stage_residuals}, monotonicity_residual={monotonicity_residual}"
        )
    exclusive = {}
    for t in teams:
        p = probs[t]
        exclusive[t] = {
            "no_playoffs": 1.0 - p["berth"],
            "wild_card": p["berth"] - p["divisional"],
            "divisional": p["divisional"] - p["conference"],
            "conference": p["conference"] - p["sb_berth"],
            "sb_loss": p["sb_berth"] - p["sb_win"],
            "sb_win": p["sb_win"],
        }
    return {
        "probs": probs,
        "exclusive": exclusive,
        "alphas": alphas,
        "residuals": stage_residuals,
        "monotonicity_residual": monotonicity_residual,
        "iterations": iteration,
        "converged": converged,
        "method_version": method_version,
        "fixed_facts": fixed_stage,
    }
