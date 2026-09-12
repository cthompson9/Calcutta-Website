"""Focused standard-library assertions for the review-only v3 engine."""
from __future__ import annotations

import math

import engine_v3


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


if __name__ == "__main__":
    test_shift_density_ratio()
    test_market_blend_is_centered_and_ordered()
    test_tiebreak_is_deterministic_and_uses_head_to_head()
    print("all 3 v3 tests passed")