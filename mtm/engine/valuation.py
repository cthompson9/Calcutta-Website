"""Assemble the mark: projections + realized facts -> E[points] -> share -> payout.

The identity (fixed_inventory format only):

    E[points] = banked
              + per_win * (realized_wins + e_remaining_wins)
              + per_tie * (realized_ties + e_remaining_ties)
              + per_pt_diff * (realized_adj_diff + e_remaining_raw_diff
                                                 + e_remaining_marquee_addon)
              + sum_stage bonus_stage * P(reach stage)

    E[share]  = E[points] / denominator
    E[payout] = E[share] * pot

Realized values MUST come from the pool's own scoring engine (the two-pass,
456/456-tested one) - never re-derived from markets. Playoff bonuses already
banked (e.g. a berth clinched) arrive as P = 1.0 from the settled elimination
market and price correctly with no special casing.
"""
from __future__ import annotations

import math

STAGES = ["berth", "divisional", "conference", "sb_berth", "sb_win"]


def _allocate_payout_cents(expected: dict[str, float], pot: float) -> dict[str, float]:
    """Round team payouts to cents while preserving the pool exactly."""
    target_cents = round(pot * 100)
    raw_cents = {team: max(0.0, value * 100) for team, value in expected.items()}
    cents = {team: math.floor(value) for team, value in raw_cents.items()}
    remainder = target_cents - sum(cents.values())
    ranked = sorted(
        expected,
        key=lambda team: (raw_cents[team] - cents[team], team),
        reverse=True,
    )
    if remainder < 0 or remainder > len(ranked):
        raise ValueError(
            f"simulated payouts do not conserve the pool before rounding: "
            f"{sum(expected.values()):.6f} versus {pot:.6f}"
        )
    for team in ranked[:remainder]:
        cents[team] += 1
    return {team: value / 100 for team, value in cents.items()}


def value_team(rubric: dict,
               realized: dict,
               projection: dict) -> dict:
    """realized: {wins, ties, adj_pt_diff}  (adj = raw + marquee addon, engine-computed)
    projection: {e_remaining_wins, e_remaining_ties, e_remaining_raw_diff,
                 e_remaining_marquee_addon, p_stage: {stage: prob}}
    """
    pts = float(rubric["banked"])
    pts += rubric["per_win"] * (realized["wins"] + projection["e_remaining_wins"])
    pts += rubric["per_tie"] * (realized.get("ties", 0) + projection.get("e_remaining_ties", 0.0))
    pts += rubric["per_pt_diff"] * (
        realized["adj_pt_diff"]
        + projection["e_remaining_raw_diff"]
        + projection["e_remaining_marquee_addon"]
    )
    bonus = 0.0
    for s in STAGES:
        bonus += rubric["bonuses"][s] * projection["p_stage"][s]
    pts += bonus

    share = pts / rubric["denominator"]
    return {
        "expected_points": round(pts, 2),
        "expected_share": round(share, 6),
        "bonus_ev": round(bonus, 2),
    }


def value_pool(rubric: dict,
               realized_by_team: dict[str, dict],
               projection_by_team: dict[str, dict],
               entries: list[dict],
               pot: float) -> dict:
    """entries: [{entry_id, team, price}] - one team per lot in NFL pools.
    Returns per-entry valuations + league-level sanity diagnostics."""
    team_vals = {t: value_team(rubric, realized_by_team[t], projection_by_team[t])
                 for t in realized_by_team}

    rows = []
    for e in entries:
        tv = team_vals[e["team"]]
        payout = tv["expected_share"] * pot
        rows.append({
            "entry_id": e["entry_id"],
            "team": e["team"],
            "expected_points": tv["expected_points"],
            "expected_share": tv["expected_share"],
            "expected_payout": round(payout, 2),
            "auction_price": e.get("price"),
            "mtm_multiple": round(payout / e["price"], 3) if e.get("price") else None,
        })

    league_points = sum(v["expected_points"] for v in team_vals.values())
    diagnostics = {
        "league_expected_points": round(league_points, 1),
        "denominator": rubric["denominator"],
        "coverage": round(league_points / rubric["denominator"], 5),
        "note": "coverage converges to 1.0 as the season resolves; a full-season "
                "mark should sit close to 1.0 (diff terms are zero-sum; bonus EV "
                "sums to 3900 by the stage-target normalization; win EV sums to "
                "2720 only if E[total league wins]=272, i.e. ties priced at ~0).",
    }
    return {"entries": rows, "team_valuations": team_vals, "diagnostics": diagnostics}


def value_simulation(rubric: dict, entries: list[dict], pot: float,
                     simulation: dict, games: list,
                     min_conditional_samples: int = 100,
                     min_conditional_share: float = 0.01) -> dict:
    """Turn aggregate Monte Carlo results into the authoritative mark.

    ``simulation`` contains sums, not raw paths.  Each path was normalized to
    the pot before its sum was accumulated, which is important when ties or
    other path-level inventory effects change the denominator.
    """
    runs = int(simulation.get("runs", 0))
    sums = simulation.get("payout_sum", {})
    sqs = simulation.get("payout_sq_sum", {})
    teams = list(sums)
    expected = {t: (sums[t] / runs if runs else 0.0) for t in teams}
    published = _allocate_payout_cents(expected, pot)
    rows = []
    for e in entries:
        t = e["team"]
        gross = published.get(t, 0.0)
        rows.append({
            "entry_id": e["entry_id"], "team": t,
            "expected_points": None, "expected_share": gross / pot if pot else 0.0,
            "expected_payout": gross,
            "gross_expected_payout": gross,
            "net_convenience": round(gross - (e.get("price") or 0), 2),
            "auction_price": e.get("price"),
            "mtm_multiple": round(gross / e["price"], 3) if e.get("price") else None,
        })
    total = sum(published.values())
    cond_out = {}
    for gi, g in enumerate(games):
        cond_out[str(gi)] = {"home": g.home, "away": g.away, "week": g.week,
                             "event_id": g.event_id, "outcomes": {}}
        buckets = simulation.get("conditional_payouts", {}).get(gi, {})
        for outcome, b in buckets.items():
            n = b["count"]
            weight = b.get("weight", n)
            weight_sq = b.get("weight_sq", n)
            team_data = {}
            for t in teams:
                mean = b["sum"][t] / weight if weight else None
                variance = max(0.0, b["sq"][t] / weight - mean * mean) if weight else None
                effective_n = weight * weight / weight_sq if weight_sq else 0.0
                sufficient = effective_n >= min_conditional_samples and (
                    weight / runs >= min_conditional_share if runs else False)
                # Reconciliation is a game/team property, not an outcome
                # property: all three conditional buckets must be weighted
                # together before comparing to the unconditional baseline.
                weighted = sum(
                    x.get("weight", x["count"]) / runs
                    * (x["sum"][t] / x.get("weight", x["count"]))
                    for x in buckets.values() if x.get("weight", x["count"]) and runs)
                team_data[t] = {
                    "gross_expected_payout": round(mean, 2) if mean is not None else None,
                    "sample_count": n,
                    "sample_share": weight / runs if runs else 0.0,
                    "effective_sample_size": round(effective_n, 2),
                    "standard_error": round(math.sqrt(variance / effective_n), 4)
                    if effective_n else None,
                    "quality_status": "good" if sufficient else "insufficient",
                    "reconciliation_residual": round(
                        weighted - expected.get(t, 0.0), 6) if runs else None,
                }
            cond_out[str(gi)]["outcomes"][outcome] = team_data
    # A useful run-level invariant: normalized payouts sum to pot on every
    # simulated path (up to floating point accumulation).
    diagnostics = {
        "path_count": runs,
        "gross_payout_total": round(total, 2),
        "pot": pot,
        "conservation_residual": round(total - pot, 6),
        "conservation_status": "ok" if abs(total - pot) <= max(.01, pot * 1e-6) else "warning",
        "effective_sample_size": round(simulation.get("effective_sample_size", runs), 2),
        "market_calibration_converged": simulation.get("calibration_converged", True),
    }
    team_valuations = {
        t: {"gross_expected_payout": published[t],
            "net_convenience": round(published[t] - sum(
                e.get("price", 0) or 0 for e in entries if e["team"] == t), 2)}
        for t in teams
    }
    return {"entries": rows, "team_valuations": team_valuations,
            "conditional_payouts": cond_out,
            "diagnostics": diagnostics}
