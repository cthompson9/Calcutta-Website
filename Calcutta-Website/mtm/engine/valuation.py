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

STAGES = ["berth", "divisional", "conference", "sb_berth", "sb_win"]


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
