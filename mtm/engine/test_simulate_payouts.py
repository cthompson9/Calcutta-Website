import unittest

from simulate import _normalize_path_payouts


class PathPayoutNormalizationTests(unittest.TestCase):
    def test_floors_negative_points_before_conserving_the_pool(self):
        payouts = _normalize_path_payouts({
            "A": 80.0,
            "B": 20.0,
            "C": -10.0,
        }, 97_625.0)

        self.assertEqual(payouts["C"], 0.0)
        self.assertAlmostEqual(sum(payouts.values()), 97_625.0, places=8)
        self.assertAlmostEqual(payouts["A"], 78_100.0, places=8)
        self.assertAlmostEqual(payouts["B"], 19_525.0, places=8)

    def test_rejects_a_path_with_no_payable_points(self):
        with self.assertRaisesRegex(ValueError, "no positive payable points"):
            _normalize_path_payouts({"A": 0.0, "B": -1.0}, 100.0)


if __name__ == "__main__":
    unittest.main()