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


def reach_from_elimination(elim_probs: dict[str, float]) -> dict[str, float]:
    """elim_probs: outcome -> raw prob (bid+1c). Missing outcomes treated as 0."""
    p = {k: max(0.0, min(1.0, elim_probs.get(k, 0.0))) for k in ELIM_ORDER}
    return {
        "berth": p["wild_card"] + p["divisional"] + p["conference"] + p["sb_loss"] + p["sb_win"],
        "divisional": p["divisional"] + p["conference"] + p["sb_loss"] + p["sb_win"],
        "conference": p["conference"] + p["sb_loss"] + p["sb_win"],
        "sb_berth": p["sb_loss"] + p["sb_win"],
        "sb_win": p["sb_win"],
    }


def _power_alpha(probs: list[float], target: float,
                 lo: float = 1e-4, hi: float = 1e4, iters: int = 200) -> float:
    """Bisect alpha so sum(p^alpha) = target. p^alpha is decreasing in alpha
    for p in (0,1), so f(alpha) = sum(p^alpha) - target is decreasing."""
    clean = [min(max(p, 1e-9), 1 - 1e-9) for p in probs]

    def f(a: float) -> float:
        return sum(p ** a for p in clean) - target

    if f(lo) < 0:   # even alpha->0 can't reach target (target > n); cap
        return lo
    if f(hi) > 0:   # even huge alpha exceeds target; floor
        return hi
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
    fixed = {t: min(max(team_probs[t], 1e-9), 1 - 1e-9) ** alpha for t in teams}
    return fixed, alpha


def normalize_all(reach_by_team: dict[str, dict[str, float]],
                  targets: dict[str, float],
                  rounds: int = 2) -> dict:
    """reach_by_team: team -> {stage: raw prob}. Returns normalized probs,
    per-stage alphas, and residuals (post-monotone-clamp sum error).
    Teams already eliminated/clinched should arrive as exact 0/1 and are
    held fixed (their contracts have settled; only open probs get scaled)."""
    teams = list(reach_by_team.keys())
    probs = {t: dict(reach_by_team[t]) for t in teams}
    alphas: dict[str, float] = {}

    for _ in range(rounds):
        # 1) per-stage power normalization over non-settled teams
        for stage in STAGES:
            open_teams = [t for t in teams if 0.0 < probs[t][stage] < 1.0]
            settled_sum = sum(probs[t][stage] for t in teams if t not in open_teams)
            remaining_target = targets[stage] - settled_sum
            if open_teams and remaining_target > 0:
                sub = {t: probs[t][stage] for t in open_teams}
                fixed, alpha = normalize_stage(sub, remaining_target)
                for t in open_teams:
                    probs[t][stage] = fixed[t]
                # cumulative across rounds; round 1 carries the real de-vig signal
                alphas[stage] = round(alphas.get(stage, 1.0) * alpha, 4)
        # 2) per-team monotone clamp: berth >= divisional >= ... >= sb_win
        for t in teams:
            prev = 1.0
            for stage in STAGES:
                probs[t][stage] = min(probs[t][stage], prev)
                prev = probs[t][stage]

    residuals = {s: round(sum(probs[t][s] for t in teams) - targets[s], 4) for s in STAGES}
    return {"probs": probs, "alphas": alphas, "residuals": residuals}
