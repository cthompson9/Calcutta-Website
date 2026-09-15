import unittest

from valuation import _allocate_payout_cents


class PayoutAllocationTests(unittest.TestCase):
    def test_accepts_binary_roundoff_and_conserves_the_pool_to_the_cent(self):
        pot = 97_625.0
        expected = {
            "A": 50_000.0000004,
            "B": 30_000.0,
            "C": 17_624.9999992,
        }

        allocated = _allocate_payout_cents(expected, pot)

        self.assertEqual(sum(round(value * 100) for value in allocated.values()), 9_762_500)

    def test_rejects_a_material_unrounded_pool_discrepancy(self):
        with self.assertRaisesRegex(ValueError, "do not conserve the pool"):
            _allocate_payout_cents({"A": 60.0, "B": 39.99}, 100.0)


if __name__ == "__main__":
    unittest.main()