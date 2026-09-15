"""Offline path proposals with an exact Gaussian-mixture likelihood correction.

The base law, brackets, margins and payout rules stay fixed. A mixture component
shifts one team's game margins to obtain more rare playoff paths. Every path is
weighted by p(path)/sum_j alpha_j q_j(path), including the base component.
Selection must be frozen using a separate pilot before validation samples run.
This module is not selected by the official runner.
"""
from __future__ import annotations

import math


class MarginMixtureProposal:
    version = "gaussian-margin-mixture-review-v1"

    def __init__(self, teams, *, base_fraction=0.5, regular_shift=6.0,
                 playoff_shift=10.0):
        self.teams = tuple(sorted(teams))
        if len(self.teams) != len(set(self.teams)) or not self.teams:
            raise ValueError("Proposal teams must be unique and nonempty")
        if not (0 < base_fraction <= 1):
            raise ValueError("A positive base component is required")
        if not all(math.isfinite(v) and v >= 0 for v in (regular_shift, playoff_shift)):
            raise ValueError("Invalid margin shifts")
        self.base_fraction = base_fraction
        self.regular_shift = regular_shift
        self.playoff_shift = playoff_shift
        self.index = {team:i for i,team in enumerate(self.teams)}
        self.component_counts = [0] * (len(self.teams)+1)
        self.log_ratios = []
        self.component = None

    def start_path(self, rng):
        draw = rng.random()
        if draw < self.base_fraction:
            self.component = None
            self.component_counts[0] += 1
        else:
            index = min(int((draw-self.base_fraction) /
                            (1-self.base_fraction)*len(self.teams)),len(self.teams)-1)
            self.component = self.teams[index]
            self.component_counts[index+1] += 1
        self.log_ratios = [0.0] * len(self.teams)

    def sample_margin(self, a, b, mean, sd, *, playoff, rng):
        shift = self.playoff_shift if playoff else self.regular_shift
        sampled_shift = shift if self.component == a else -shift if self.component == b else 0.0
        margin = rng.gauss(mean+sampled_shift,sd)
        variance = sd*sd
        # For all other mixture components q_j/p contributes exactly one.
        if a in self.index:
            self.log_ratios[self.index[a]] += shift*(margin-mean)/variance-shift*shift/(2*variance)
        if b in self.index:
            self.log_ratios[self.index[b]] += -shift*(margin-mean)/variance-shift*shift/(2*variance)
        return margin

    def path_weight(self):
        if self.base_fraction == 1:
            return 1.0
        log_alpha = math.log((1-self.base_fraction)/len(self.teams))
        terms = [math.log(self.base_fraction)] + [log_alpha+x for x in self.log_ratios]
        largest = max(terms)
        log_q_over_p = largest + math.log(sum(math.exp(x-largest) for x in terms))
        weight = math.exp(-log_q_over_p)
        if not math.isfinite(weight) or weight <= 0:
            raise ArithmeticError("Nonfinite or underflowed proposal correction")
        return weight

    def diagnostics(self):
        return {"version":self.version, "review_only":True,
                "teams":list(self.teams), "base_fraction":self.base_fraction,
                "regular_shift":self.regular_shift,"playoff_shift":self.playoff_shift,
                "component_counts":self.component_counts,
                "weighting":"base_density / full_mixture_density",
                "selection":"frozen independent pilot; no within-batch adaptation"}
