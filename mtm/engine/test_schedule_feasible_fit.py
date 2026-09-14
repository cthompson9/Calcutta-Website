import math

import schedule_feasible_fit as candidate
import simulate


def _fit(targets, games, **settings):
    return candidate.fit_schedule_feasible_candidate(targets, games, **settings)


def test_feasible_targets_fit_and_conserve():
    result = _fit(
        {"A": .7, "B": .3, "C": .2, "D": .8},
        [{"home": "A", "away": "B"}, {"home": "C", "away": "D"}],
    )
    assert result["status"] == "ok"
    assert math.isclose(sum(result["fitted_expectations"].values()), 2.0,
                        abs_tol=1e-12)
    assert result["market_compatibility"]["passed"]
    for team, expectation in result["fitted_expectations"].items():
        assert 0 <= expectation <= 1


def test_incompatible_one_game_exposes_discrepancy_without_rescaling():
    result = _fit(
        {"A": .7, "B": .7},
        [{"home": "A", "away": "B"}],
    )
    assert result["raw_targets"] == {"A": .7, "B": .7}
    assert math.isclose(result["raw_target_total"], 1.4)
    assert math.isclose(result["schedule"]["available_remaining_wins"], 1.0)
    assert math.isclose(sum(result["fitted_expectations"].values()), 1.0)
    assert math.isclose(result["absolute_adjustment_total"], .4, abs_tol=1e-8)
    assert result["market_compatibility"]["status"] == "incompatible"
    assert result["termination"]["numerically_converged"]


def test_input_order_is_reproducible_and_confidence_is_explicit():
    targets = {"A": .8, "B": .5, "C": .7}
    games = [
        {"home": "A", "away": "B", "week": 2},
        {"home": "C", "away": "A", "week": 1},
    ]
    first = _fit(targets, games, accepted_evidence_confidence={
        "A": 3, "B": 2, "C": 1})
    second = _fit(dict(reversed(list(targets.items()))), list(reversed(games)),
                  accepted_evidence_confidence={"C": 1, "B": 2, "A": 3})
    assert first["ratings"] == second["ratings"]
    assert first["fitted_expectations"] == second["fitted_expectations"]
    assert first["weighting"]["basis"] == "accepted_evidence_confidence"
    fallback = _fit(targets, games, accepted_evidence_confidence={"A": 3})
    assert fallback["weighting"]["basis"] == "equal_weighting_no_complete_confidence"


def test_completed_and_disconnected_schedules_are_explicit():
    completed = _fit({"A": 0, "B": 0}, [])
    assert completed["schedule"]["status"] == "completed"
    assert completed["fitted_expectations"] == {"A": 0.0, "B": 0.0}
    assert completed["schedule"]["unidentified_relative_strengths"]
    incompatible = _fit({"A": .1}, [])
    assert incompatible["fit"]["invalid_target_teams"] == ["A"]
    assert not incompatible["market_compatibility"]["passed"]

    disconnected = _fit(
        {"A": .6, "B": .4, "C": .7, "D": .3},
        [{"home": "A", "away": "B"}, {"home": "C", "away": "D"}],
    )
    assert disconnected["schedule"]["status"] == "disconnected"
    assert disconnected["schedule"]["unidentified_relative_strengths"]
    assert "between disconnected components" in (
        disconnected["schedule"]["cross_component_identifiability"])
    assert all(abs(row["raw_total_minus_available_wins"]) < 1e-12
               for row in disconnected["schedule"]["component_conservation"])
    for component in disconnected["schedule"]["components"]:
        assert abs(sum(disconnected["ratings"][team] for team in component)) < 1e-10


def test_invalid_schedule_and_numerical_failure_fail_closed():
    invalid = _fit({"A": .5}, [{"home": "A", "away": "MISSING"}])
    assert invalid["termination"]["reason"] == "invalid_schedule"
    numerical = _fit({"A": .5, "B": .5}, [{"home": "A", "away": "B"}],
                     margin_sd=float("nan"))
    assert numerical["termination"]["reason"] == "invalid_input"
    overflow = _fit(
        {"A": .9, "B": .1}, [{"home": "A", "away": "B"}],
        accepted_evidence_confidence={"A": 1e308, "B": 1e308},
    )
    assert overflow["termination"]["reason"] == "numerical_failure"
    stalled = _fit({"A": .9, "B": .1}, [{"home": "A", "away": "B"}],
                   max_iterations=1, gradient_tolerance=0)
    assert stalled["status"] == "failed"
    assert stalled["termination"]["reason"] == "maximum_iterations"


def test_candidate_does_not_change_official_fitter_results():
    targets = {"A": .6, "B": .4}
    games = [simulate.Game(home="A", away="B")]
    before = simulate.fit_ratings(targets, games, iters=20)
    _fit(targets, [{"home": "A", "away": "B"}])
    after = simulate.fit_ratings(targets, games, iters=20)
    assert before == after


if __name__ == "__main__":
    test_feasible_targets_fit_and_conserve()
    test_incompatible_one_game_exposes_discrepancy_without_rescaling()
    test_input_order_is_reproducible_and_confidence_is_explicit()
    test_completed_and_disconnected_schedules_are_explicit()
    test_invalid_schedule_and_numerical_failure_fail_closed()
    test_candidate_does_not_change_official_fitter_results()
    print("all schedule-feasible candidate tests passed")