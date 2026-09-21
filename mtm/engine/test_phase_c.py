"""Focused regressions for the reference-mark-power-v1 official path."""
from __future__ import annotations

import unittest

import playoffs
import simulate
import valuation
import wins


def _raw(value: float = 0.2) -> dict[str, float]:
    return {
        "no_playoffs": value,
        "wild_card": value,
        "divisional": value,
        "conference": value,
        "sb_loss": value,
        "sb_win": value,
    }


class ReferenceMarkPowerTests(unittest.TestCase):
    def test_exclusive_facts_and_no_playoffs_participate(self):
        result = playoffs.normalize_exclusive(
            _raw(),
            {"no_playoffs": True},
        )
        self.assertAlmostEqual(result["probabilities"]["no_playoffs"], 0.2)
        self.assertAlmostEqual(sum(result["probabilities"].values()), 1.0, places=8)
        self.assertNotEqual(result["probabilities"]["no_playoffs"], 0.0)

    def test_active_endpoint_is_not_treated_as_fixed_fact(self):
        active = playoffs.normalize_exclusive(
            {**_raw(), "sb_win": 1.0}
        )
        fixed = playoffs.normalize_exclusive(
            {**_raw(), "sb_win": 1.0},
            {"sb_win": True},
        )
        self.assertLess(active["probabilities"]["sb_win"], 1.0)
        self.assertEqual(fixed["probabilities"]["sb_win"], 1.0)

    def test_infeasible_fixed_facts_fail_closed(self):
        with self.assertRaises(ValueError):
            playoffs.normalize_exclusive(
                {"no_playoffs": 1.0, "wild_card": 1.0,
                 "divisional": 0.0, "conference": 0.0,
                 "sb_loss": 0.0, "sb_win": 0.0},
                {"no_playoffs": True, "wild_card": True},
            )

    def test_inventory_residual_and_nested_monotonicity(self):
        teams = {
            f"T{i}": playoffs.reach_from_elimination(_raw(0.15 + i / 1000))
            for i in range(32)
        }
        result = playoffs.normalize_all(
            teams,
            {"berth": 14, "divisional": 8, "conference": 4,
             "sb_berth": 2, "sb_win": 1},
        )
        self.assertTrue(result["converged"])
        self.assertLessEqual(max(abs(v) for v in result["residuals"].values()), 1e-8)
        for probabilities in result["probs"].values():
            for earlier, later in zip(playoffs.STAGES, playoffs.STAGES[1:]):
                self.assertLessEqual(probabilities[later], probabilities[earlier] + 1e-8)

    def test_fixed_stage_facts_are_accounted_for_in_inventory(self):
        teams = {f"T{i}": playoffs.reach_from_elimination(_raw()) for i in range(32)}
        # A fixed reach fact must be represented by the corresponding raw
        # cumulative value; the test team is overridden to a settled win.
        teams["T0"] = {stage: 1.0 for stage in playoffs.STAGES}
        result = playoffs.normalize_all(
            teams,
            {"berth": 14, "divisional": 8, "conference": 4,
             "sb_berth": 2, "sb_win": 1},
            fixed={"T0": {stage: True for stage in playoffs.STAGES}},
        )
        self.assertAlmostEqual(result["probs"]["T0"]["sb_win"], 1.0)
        self.assertLessEqual(max(abs(v) for v in result["residuals"].values()), 1e-8)

    def test_point_ladder_labels_interpolation(self):
        result = wins.expected_wins_from_ladder(
            [wins.Rung(4, None, None, reference_price=0.7),
             wins.Rung(8, None, None, reference_price=0.4)],
            games=10,
        )
        self.assertEqual(result["method"], "ladder_sum")
        self.assertEqual(result["diagnostics"]["interpolation_label"],
                         "model_interpolated_missing_rungs")
        self.assertEqual(len(result["curve"]), 12)

    def test_no_remaining_games_is_handled(self):
        result = simulate.fit_ratings(
            {"ARI": 0.0, "BAL": 0.0},
            [],
        )
        self.assertTrue(result["fit_diagnostics"]["converged"])
        self.assertEqual(result["max_abs_win_error"], 0.0)

    def test_pool_conservation_after_payout_rounding(self):
        payouts = valuation._allocate_payout_cents(
            {"A": 33.3333, "B": 33.3333, "C": 33.3334},
            100.0,
        )
        self.assertEqual(sum(payouts.values()), 100.0)


if __name__ == "__main__":
    unittest.main()