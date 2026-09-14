"""Reduced deterministic checks for the review-only joint fitter."""
from __future__ import annotations

import json

import joint_fit


def _scenarios():
    return [
        {"id": "longshot", "prior_weight": 1, "metrics": {
            "wins:KC:10": 0, "stage:KC:berth": 0, "game:G1": "away",
        }},
        {"id": "favorite", "prior_weight": 3, "metrics": {
            "wins:KC:10": 1, "stage:KC:berth": 1, "game:G1": "home",
        }},
    ]


def test_joint_fit_is_order_independent_and_normalized():
    evidence = [
        {"name": "advancement", "metric": "stage:KC:berth",
         "interval": [0.4, 0.9], "group": "playoffs"},
        {"name": "wins", "metric": "wins:KC:10",
         "interval": [0.4, 0.9], "group": "wins"},
    ]
    first = joint_fit.fit_joint_weights(_scenarios(), evidence)
    second = joint_fit.fit_joint_weights(list(reversed(_scenarios())),
                                         list(reversed(evidence)))
    assert first["status"] == second["status"] == "converged"
    assert first["weights"] == second["weights"]
    assert abs(sum(first["weights"].values()) - 1) < 1e-12
    assert all(value >= 0 for value in first["weights"].values())
    json.dumps(first)


def test_resolved_fact_removes_incompatible_paths_and_reports_support():
    result = joint_fit.fit_joint_weights(
        _scenarios(),
        [{"name": "win", "metric": "wins:KC:10", "lower": 1, "upper": 1}],
        resolved_facts={"game:G1": "home"},
    )
    assert result["status"] == "converged"
    assert result["weights"] == {"favorite": 1.0}
    assert result["diagnostics"]["rejected_scenarios"][0]["reason"] == "resolved_fact"


def test_timeout_is_a_clean_failed_review():
    result = joint_fit.fit_joint_weights(
        _scenarios(),
        [{"name": "win", "metric": "wins:KC:10", "lower": 0, "upper": 1}],
        max_seconds=0,
    )
    assert result["status"] == "failed"
    assert result["diagnostics"]["solver_status"]["status"] == "timeout"


def test_no_playoffs_is_the_berth_complement_and_duplicates_do_not_add_confidence():
    scenarios = joint_fit.scenarios_from_path_library([
        {"id": "in", "wins": {"KC": 10}, "advancement": {"KC": {"berth": 1}}},
        {"id": "out", "wins": {"KC": 9}, "advancement": {"KC": {"berth": 0}}},
    ])
    evidence = [
        {"name": "no-playoffs-a", "metric": "no_playoffs:KC",
         "lower": .49, "upper": .51, "reliability": 2},
        {"name": "no-playoffs-b", "metric": "no_playoffs:KC",
         "lower": .49, "upper": .51, "reliability": 2},
    ]
    result = joint_fit.fit_joint_weights(scenarios, evidence)
    assert result["status"] == "converged"
    assert len(result["diagnostics"]["interval_residuals"]) == 1
    assert result["expected_metrics"]["no_playoffs:KC"] == .5


def test_path_features_keep_cumulative_advancement_semantics():
    scenarios = joint_fit.scenarios_from_path_library([{
        "id": "champion", "wins": {"KC": 12},
        "advancement": {"KC": {
            "berth": 1, "divisional": 1, "conference": 1,
            "sb_berth": 1, "sb_win": 1,
        }},
    }])
    metrics = scenarios[0]["metrics"]
    assert all(metrics[f"stage:KC:{stage}"] == 1 for stage in (
        "berth", "divisional", "conference", "sb_berth", "sb_win"
    ))
    assert metrics["no_playoffs:KC"] == 0


def test_unsupported_deep_interval_is_a_support_failure():
    result = joint_fit.fit_joint_weights(
        [{"id": "only", "metrics": {"wins:KC:39": 0}}],
        [{"name": "deep", "metric": "wins:KC:39", "lower": .9, "upper": 1.0}],
    )
    assert result["status"] == "failed"
    assert result["diagnostics"]["support_failures"]


def test_group_cap_limits_reliability_precision():
    scenarios = [
        {"id": "a", "metrics": {"m": 1}},
        {"id": "b", "metrics": {"m": 0}},
    ]
    result = joint_fit.fit_joint_weights(
        scenarios,
        [
            {"name": "one", "metric": "m", "lower": .2, "upper": .8,
             "group": "quotes", "reliability": 10},
            {"name": "repeat", "metric": "m", "lower": .2, "upper": .8,
             "group": "quotes", "reliability": 10},
        ],
        precision_caps={"quotes": .5},
    )
    assert result["diagnostics"]["evidence_group_precision"]["quotes"] <= .5


def test_settled_evidence_filters_paths_and_one_sided_bounds_are_literal():
    scenarios = [
        {"id": "yes", "metrics": {"wins:KC:10": 1}},
        {"id": "no", "metrics": {"wins:KC:10": 0}},
    ]
    settled = joint_fit.fit_joint_weights(
        scenarios,
        [{"name": "settled", "metric": "wins:KC:10", "lower": 1, "upper": 1,
          "resolved": True}],
    )
    assert settled["status"] == "converged"
    assert settled["weights"] == {"yes": 1.0}
    bounds = joint_fit.constraints_from_markets({
        "win_ladders": {"KC": [
            {"strike": 10, "yes_bid": .4, "yes_ask": None},
            {"strike": 11, "yes_bid": None, "yes_ask": .6},
        ]},
        "elimination_quotes": {},
    })
    assert [(row["lower"], row["upper"]) for row in bounds] == [(.4, 1), (0, .6)]


def test_tighter_interval_has_no_less_influence_and_strong_residual_fails():
    scenarios = [
        {"id": "yes", "metrics": {"m": 1}},
        {"id": "no", "metrics": {"m": 0}},
    ]
    tight = joint_fit.fit_joint_weights(
        scenarios, [{"name": "tight", "metric": "m", "lower": .8, "upper": .81}]
    )
    wide = joint_fit.fit_joint_weights(
        scenarios, [{"name": "wide", "metric": "m", "lower": .4, "upper": .6}]
    )
    assert tight["expected_metrics"]["m"] >= wide["expected_metrics"]["m"]
    outside = joint_fit.fit_joint_weights(
        scenarios, [{"name": "strong", "metric": "m", "lower": .91, "upper": .91,
                     "reliability": 100}],
    )
    assert outside["status"] == "failed"
    assert outside["diagnostics"]["solver_status"]["status"] == "interval_residual"


if __name__ == "__main__":
    test_joint_fit_is_order_independent_and_normalized()
    test_resolved_fact_removes_incompatible_paths_and_reports_support()
    test_timeout_is_a_clean_failed_review()
    test_no_playoffs_is_the_berth_complement_and_duplicates_do_not_add_confidence()
    test_path_features_keep_cumulative_advancement_semantics()
    test_unsupported_deep_interval_is_a_support_failure()
    test_group_cap_limits_reliability_precision()
    test_settled_evidence_filters_paths_and_one_sided_bounds_are_literal()
    test_tighter_interval_has_no_less_influence_and_strong_residual_fails()
    print("joint fit tests passed")