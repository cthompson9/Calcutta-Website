"""Focused standard-library assertions for the review-only v3 engine."""
from __future__ import annotations

import math

import engine_v3
import run_mtm_v3


def test_shift_density_ratio() -> None:
    means = {"A": 0.0, "B": 0.0}
    proposals = [("A", 4.0)]
    fractions = [.75, .25]
    at_base = engine_v3._proposal_ratio_to_base(
        {"A": 0.0, "B": 1.0}, means, 3.0, proposals, fractions)
    expected = .75 + .25 * math.exp(-.5 * 16 / 9)
    assert abs(at_base - expected) < 1e-12
    at_shift = engine_v3._proposal_ratio_to_base(
        {"A": 4.0, "B": -2.0}, means, 3.0, proposals, fractions)
    assert at_shift > 1.0


def test_market_blend_is_centered_and_ordered() -> None:
    base = {"A": 0.0, "B": 0.0}
    targets = {
        "A": {stage: .8 for stage in engine_v3.STAGES},
        "B": {stage: .2 for stage in engine_v3.STAGES},
    }
    adjusted = engine_v3.blend_playoff_futures(base, targets, 2.0)
    assert abs(sum(adjusted.values())) < 1e-12
    assert adjusted["A"] > adjusted["B"]


def test_tiebreak_is_deterministic_and_uses_head_to_head() -> None:
    teams = [f"T{i:02}" for i in range(32)]
    divisions = {
        f"{'AFC' if i < 4 else 'NFC'} D{i % 4}": teams[i * 4:(i + 1) * 4]
        for i in range(8)
    }
    records = [
        {"home": "T00", "away": "T01", "outcome": "decided", "winner": "T00"},
        {"home": "T01", "away": "T02", "outcome": "decided", "winner": "T01"},
        {"home": "T02", "away": "T03", "outcome": "decided", "winner": "T02"},
        {"home": "T03", "away": "T00", "outcome": "decided", "winner": "T03"},
    ]
    context = engine_v3.build_tiebreak_context(
        teams, records, divisions, {team: 0.0 for team in teams})
    first = engine_v3.rank_teams(["T00", "T01"], context)
    second = engine_v3.rank_teams(["T00", "T01"], context)
    assert first == second == ["T00", "T01"]


def test_review_endpoint_reaches_joint_fit_without_becoming_canonical() -> None:
    teams = [f"T{i:02}" for i in range(32)]
    divisions = {
        f"{'AFC' if i < 4 else 'NFC'} D{i % 4}": teams[i * 4:(i + 1) * 4]
        for i in range(8)
    }
    realized = {team: {"wins": 0, "ties": 0, "adj_pt_diff": 0} for team in teams}
    paths = []
    for index in range(1000):
        paths.append({
            "id": f"p{index:04}", "wins": {team: 0 for team in teams},
            "advancement": {team: {"berth": 0} for team in teams},
            "payout": {team: 100 / 32 for team in teams}, "outcomes": {},
        })

    def fake_simulate_v3(**_kwargs):
        return {
            "status": "ok", "runs": len(paths), "expected_payout": {
                team: 100 / 32 for team in teams
            }, "stage_probs": {team: {} for team in teams},
            "conditionals": {}, "path_library": paths,
            "diagnostics": {"market_residuals": [], "generated_expected_wins": {
                team: 0 for team in teams
            }},
        }

    config = {
        "season": 2026, "games_per_team": 17,
        "sim": {"seed": 7, "hfa_points": 1.6, "margin_sd": 13.5},
        "sim_v3_review": {"runs": 1000, "pilot_runs": 0},
        "rubric": {"banked": 0, "per_win": 1, "per_tie": 0,
                   "per_pt_diff": 0, "bonuses": {}},
        "stage_targets": {stage: 0 for stage in engine_v3.STAGES},
        "pricing": {"max_spread_for_mid": .15},
    }
    state = {
        "realized": realized, "divisions": divisions, "pot": 100,
        "entries": [], "remaining_schedule": [], "completed_results": [],
        "win_ladders": {
            team: [{"strike": 1, "yes_bid": .5, "yes_ask": .5}]
            for team in teams
        },
        "elimination_quotes": {team: {} for team in teams},
        "joint_fit_constraints": [{
            "name": f"w-{team}", "metric": f"wins:{team}:1",
            "lower": 0, "upper": 1, "group": "wins",
        } for team in teams],
        "joint_fit_group_caps": {"wins": .5},
    }
    original = engine_v3.simulate_v3
    engine_v3.simulate_v3 = fake_simulate_v3
    try:
        snapshot = run_mtm_v3.build_review_snapshot(config, state)
    finally:
        engine_v3.simulate_v3 = original
    assert snapshot["status"] == "ok", snapshot
    assert snapshot["review_only"] is True
    assert "joint_fit" in snapshot["diagnostics"]
    assert snapshot["diagnostics"]["joint_fit_gates"]["passed"] is True


if __name__ == "__main__":
    test_shift_density_ratio()
    test_market_blend_is_centered_and_ordered()
    test_tiebreak_is_deterministic_and_uses_head_to_head()
    test_review_endpoint_reaches_joint_fit_without_becoming_canonical()
    print("all 4 v3 tests passed")