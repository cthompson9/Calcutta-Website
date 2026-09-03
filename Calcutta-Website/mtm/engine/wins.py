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

    def mid(self, max_spread: float = 0.15) -> Optional[float]:
        if self.yes_bid is not None and self.yes_ask is not None:
            if (self.yes_ask - self.yes_bid) <= max_spread:
                return (self.yes_bid + self.yes_ask) / 2.0
        # one-sided or too wide: usable but flagged by caller via diagnostics
        if self.yes_bid is not None and self.yes_ask is not None:
            return (self.yes_bid + self.yes_ask) / 2.0  # wide, still best available
        if self.yes_bid is not None:
            return min(self.yes_bid + 0.01, 0.99)
        if self.yes_ask is not None:
            return max(self.yes_ask - 0.01, 0.01)
        return None


def _monotone_clamp(curve: list[Optional[float]]) -> list[Optional[float]]:
    """Force non-increasing left-to-right among known values (running min)."""
    out = list(curve)
    prev = 1.0
    for i, v in enumerate(out):
        if v is None:
            continue
        v = min(v, prev)
        out[i] = v
        prev = v
    return out


def _interpolate(curve: list[Optional[float]]) -> list[float]:
    """Linear-fill Nones. Index i holds P(W >= i). Anchors: [0]=1.0, [-1]=0.0."""
    out = list(curve)
    out[0] = 1.0
    out[-1] = 0.0
    known = [i for i, v in enumerate(out) if v is not None]
    for a, b in zip(known, known[1:]):
        for i in range(a + 1, b):
            frac = (i - a) / (b - a)
            out[i] = out[a] + frac * (out[b] - out[a])
    return [float(v) for v in out]


def expected_wins_from_ladder(rungs: list[Rung], games: int = 17,
                              max_spread: float = 0.15) -> dict:
    """Returns {'e_wins', 'method', 'curve', 'n_priced', 'diagnostics'}.

    curve[k] = P(W >= k) for k in 0..games+1 after cleaning.
    """
    curve: list[Optional[float]] = [None] * (games + 2)  # indices 0..games+1
    priced = 0
    wide = 0
    for r in rungs:
        if 1 <= r.strike <= games:
            m = r.mid(max_spread)
            if m is not None:
                curve[r.strike] = m
                priced += 1
                if r.yes_bid is not None and r.yes_ask is not None \
                        and (r.yes_ask - r.yes_bid) > max_spread:
                    wide += 1

    diagnostics = {"rungs_priced": priced, "rungs_wide_spread": wide}

    if priced >= 4:
        clamped = _monotone_clamp(curve)
        full = _interpolate(clamped)
        e_wins = sum(full[1:games + 1])
        return {"e_wins": round(e_wins, 3), "method": "ladder_sum",
                "curve": [round(v, 4) for v in full], "diagnostics": diagnostics}

    # Fallback: single rung nearest 50c. If P(W >= k) = p and the crossing is
    # roughly uniform, E[W] ~= (k - 1) + p.
    best = None
    for k in range(1, games + 1):
        v = curve[k]
        if v is None:
            continue
        if best is None or abs(v - 0.5) < abs(best[1] - 0.5):
            best = (k, v)
    if best is None:
        return {"e_wins": None, "method": "unpriced", "curve": None,
                "diagnostics": diagnostics}
    k, p = best
    return {"e_wins": round((k - 1) + p, 3), "method": "single_rung_fallback",
            "curve": None, "diagnostics": {**diagnostics, "rung_used": k}}
