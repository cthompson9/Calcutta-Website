"""E[wins] from a Kalshi win-total ladder.

The KXNFLWINS series lists 'N or more wins' contracts, so each rung IS
P(W >= N) directly. Identity used:

    E[W] = sum_{k=1..G} P(W >= k)        (G = games per team, 17)

Method: mid price per rung, monotonic clamp (P(W>=k) non-increasing in k),
linear interpolation of missing rungs between anchors P(W>=0)=1 and
P(W>=G+1)=0. Falls back to the single-rung-nearest-50c method when the
ladder is too thin to trust.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class Rung:
    strike: int                 # N in 'N or more wins'
    yes_bid: Optional[float]    # prob units (0-1), None if no bid
    yes_ask: Optional[float]
    volume: int = 0
    status: Optional[str] = None
    result: Optional[str] = None
    # Appended after the historical positional fields so interval/review
    # callers retain their original constructor contract.
    reference_price: Optional[float] = None
    selection_method: Optional[str] = None

    def observation(self) -> tuple[Optional[float], Optional[float], bool]:
        """Return probability, isotonic weight, and whether it is fixed."""
        status = (self.status or "").strip().lower()
        result = (self.result or "").strip().lower()
        if status in {"finalized", "settled"} and result in {"yes", "no"}:
            return (1.0 if result == "yes" else 0.0), None, True
        if self.reference_price is not None:
            value = float(self.reference_price)
            if 0.0 <= value <= 1.0:
                return value, 1.0, False
        if self.yes_bid is None or self.yes_ask is None:
            return None, None, False
        bid, ask = float(self.yes_bid), float(self.yes_ask)
        if not (0.0 <= bid <= ask <= 1.0):
            return None, None, False
        spread = ask - bid
        weight = min(100.0, max(1.0, 1.0 / max(spread, 0.01)))
        return (bid + ask) / 2.0, weight, False

    def mid(self, max_spread: float = 0.15) -> Optional[float]:
        """Compatibility accessor; settled results override active quotes."""
        value, _, _ = self.observation()
        return value


def _weighted_isotonic(observations: list[tuple[int, float, float, bool]]
                       ) -> dict[int, float]:
    """Weighted non-increasing PAVA with exact fixed 0/1 observations."""
    blocks = []
    for strike, value, weight, fixed in observations:
        blocks.append({
            "strikes": [strike], "value": value, "weight": weight,
            "fixed": value if fixed else None,
        })
        while len(blocks) >= 2 and blocks[-2]["value"] < blocks[-1]["value"]:
            right = blocks.pop()
            left = blocks.pop()
            fixed_values = [
                block["fixed"] for block in (left, right)
                if block["fixed"] is not None
            ]
            if len(set(fixed_values)) > 1:
                raise ValueError("settled win-total results violate monotonicity")
            fixed_value = fixed_values[0] if fixed_values else None
            weight_sum = left["weight"] + right["weight"]
            value = (
                fixed_value if fixed_value is not None else
                (left["value"] * left["weight"] +
                 right["value"] * right["weight"]) / weight_sum
            )
            blocks.append({
                "strikes": left["strikes"] + right["strikes"],
                "value": value, "weight": weight_sum, "fixed": fixed_value,
            })
    return {
        strike: float(block["value"])
        for block in blocks
        for strike in block["strikes"]
    }


def _interpolate_observed(fitted: dict[int, float], games: int) -> list[float]:
    """Fill missing strikes linearly between fixed endpoint/observed anchors."""
    anchors = {0: 1.0, games + 1: 0.0, **fitted}
    known = sorted(anchors)
    curve = [0.0] * (games + 2)
    for a, b in zip(known, known[1:]):
        curve[a] = anchors[a]
        for strike in range(a + 1, b):
            fraction = (strike - a) / (b - a)
            curve[strike] = anchors[a] + fraction * (anchors[b] - anchors[a])
    curve[known[-1]] = anchors[known[-1]]
    return curve


def expected_wins_from_ladder(rungs: list[Rung], games: int = 17,
                              max_spread: float = 0.15) -> dict:
    """Returns {'e_wins', 'method', 'curve', 'n_priced', 'diagnostics'}.

    curve[k] = P(W >= k) for k in 0..games+1 after cleaning.
    """
    observations: list[tuple[int, float, float, bool]] = []
    priced = 0
    wide = 0
    settled = []
    for r in rungs:
        if 1 <= r.strike <= games:
            value, weight, fixed = r.observation()
            if value is not None:
                observations.append((r.strike, value, weight or 1.0, fixed))
                priced += 1
                if fixed:
                    settled.append({"strike": r.strike, "result": r.result})
                elif r.yes_bid is not None and r.yes_ask is not None \
                        and (r.yes_ask - r.yes_bid) > max_spread:
                    wide += 1

    diagnostics = {
        "rungs_priced": priced, "rungs_wide_spread": wide,
        "rungs_missing": games - priced, "settled_contracts_used": settled,
        "interpolation_label": "model_interpolated_missing_rungs" if priced < games else None,
    }

    if priced:
        by_strike = {}
        for observation in observations:
            by_strike[observation[0]] = observation
        fitted = _weighted_isotonic([by_strike[k] for k in sorted(by_strike)])
        full = _interpolate_observed(fitted, games)
        e_wins = sum(full[1:games + 1])
        return {"e_wins": round(e_wins, 3), "method": "ladder_sum",
                "curve": [round(v, 4) for v in full], "diagnostics": diagnostics}
    return {"e_wins": None, "method": "unpriced", "curve": None,
            "diagnostics": diagnostics}
