"""Offline deterministic schedule-feasible team-rating candidate.

This module is intentionally not imported by the official MTM runner.  It
fits ratings against accepted remaining-win targets while preserving the
one-win-per-game schedule identity.  Raw targets are immutable audit inputs;
the returned adjustments describe the gap to the closest fitted expectations.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class CandidateGame:
    home: str
    away: str
    week: int = 0
    event_id: str | None = None


def _phi(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _pdf(value: float) -> float:
    return math.exp(-0.5 * value * value) / math.sqrt(2.0 * math.pi)


def _failure(reason: str, details: dict | None = None) -> dict:
    return {
        "status": "failed",
        "candidate": "schedule-feasible-rating-fit-v1",
        "review_only": True,
        "termination": {"reason": reason, "numerically_converged": False},
        "market_compatibility": {"status": "not_evaluated"},
        "diagnostics": details or {},
    }


def _components(teams: list[str], games: list[CandidateGame]) -> list[list[str]]:
    neighbors = {team: set() for team in teams}
    for game in games:
        neighbors[game.home].add(game.away)
        neighbors[game.away].add(game.home)
    remaining = set(teams)
    result = []
    while remaining:
        start = min(remaining)
        stack = [start]
        component = []
        remaining.remove(start)
        while stack:
            team = stack.pop()
            component.append(team)
            for neighbor in sorted(neighbors[team], reverse=True):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    stack.append(neighbor)
        result.append(sorted(component))
    return sorted(result, key=lambda row: row[0])


def fit_schedule_feasible_candidate(
    raw_targets: dict[str, float],
    remaining_schedule: list[CandidateGame | dict],
    *,
    hfa: float = 1.6,
    margin_sd: float = 13.5,
    accepted_evidence_confidence: dict[str, float] | None = None,
    publication_tolerance: float = 0.03,
    max_iterations: int = 4000,
    gradient_tolerance: float = 1e-10,
) -> dict:
    """Return a deterministic, audit-only best fit to immutable raw targets."""
    try:
        teams = sorted(str(team) for team in raw_targets)
        targets = {team: float(raw_targets[team]) for team in teams}
        games = sorted(
            [game if isinstance(game, CandidateGame) else CandidateGame(**game)
             for game in remaining_schedule],
            key=lambda game: (game.week, game.event_id or "", game.home, game.away),
        )
        scalar_values = [hfa, margin_sd, publication_tolerance,
                         gradient_tolerance, float(max_iterations), *targets.values()]
        if (not teams or not all(math.isfinite(value) for value in scalar_values)
                or margin_sd <= 0 or publication_tolerance < 0
                or max_iterations <= 0 or gradient_tolerance < 0):
            return _failure("invalid_input")
        for game in games:
            if (game.home not in targets or game.away not in targets
                    or game.home == game.away):
                return _failure("invalid_schedule", {
                    "invalid_game": {
                        "home": game.home, "away": game.away,
                        "week": game.week, "event_id": game.event_id,
                    },
                })
    except (TypeError, ValueError, OverflowError) as error:
        return _failure("invalid_input", {"error": str(error)})

    games_by_team = {team: 0 for team in teams}
    for game in games:
        games_by_team[game.home] += 1
        games_by_team[game.away] += 1
    invalid_targets = [
        team for team in teams
        if targets[team] < 0 or targets[team] > games_by_team[team]
    ]

    try:
        confidence_complete = (
            accepted_evidence_confidence is not None
            and set(accepted_evidence_confidence) == set(teams)
            and all(math.isfinite(float(accepted_evidence_confidence[team]))
                    and float(accepted_evidence_confidence[team]) > 0 for team in teams)
        )
    except (TypeError, ValueError, OverflowError):
        return _failure("invalid_evidence_confidence")
    if confidence_complete:
        weights = {team: float(accepted_evidence_confidence[team]) for team in teams}
        weighting_basis = "accepted_evidence_confidence"
    else:
        weights = {team: 1.0 for team in teams}
        weighting_basis = "equal_weighting_no_complete_confidence"

    components = _components(teams, games)
    component_conservation = []
    for component in components:
        component_set = set(component)
        component_games = sum(
            1 for game in games
            if game.home in component_set and game.away in component_set)
        component_raw_total = sum(targets[team] for team in component)
        component_conservation.append({
            "teams": component,
            "raw_target_total": component_raw_total,
            "available_wins": float(component_games),
            "raw_total_minus_available_wins":
                component_raw_total - float(component_games),
        })
    unidentified = [
        {"teams": component,
         "reason": "absolute rating level is unidentified within this schedule component"}
        for component in components
    ]
    ratings = {team: 0.0 for team in teams}

    def evaluate(candidate: dict[str, float]):
        expectations = {team: 0.0 for team in teams}
        derivatives = []
        for game in games:
            z_value = (candidate[game.home] - candidate[game.away] + hfa) / margin_sd
            probability = _phi(z_value)
            derivative = _pdf(z_value) / margin_sd
            expectations[game.home] += probability
            expectations[game.away] += 1.0 - probability
            derivatives.append((game, derivative))
        residuals = {team: expectations[team] - targets[team] for team in teams}
        objective = 0.5 * sum(
            weights[team] * residuals[team] ** 2 for team in teams)
        gradient = {team: 0.0 for team in teams}
        for game, derivative in derivatives:
            contribution = derivative * (
                weights[game.home] * residuals[game.home]
                - weights[game.away] * residuals[game.away])
            gradient[game.home] += contribution
            gradient[game.away] -= contribution
        return expectations, residuals, objective, gradient

    numerically_converged = False
    termination_reason = "maximum_iterations"
    iterations = 0
    objective_history = []
    try:
        for iteration in range(max_iterations):
            expectations, residuals, objective, gradient = evaluate(ratings)
            values = [objective, *expectations.values(), *gradient.values()]
            if not all(math.isfinite(value) for value in values):
                return _failure("numerical_failure", {
                    "iteration": iteration, "weighting_basis": weighting_basis})
            gradient_norm = math.sqrt(sum(value * value for value in gradient.values()))
            if not math.isfinite(gradient_norm):
                return _failure("numerical_failure", {
                    "iteration": iteration,
                    "weighting_basis": weighting_basis,
                    "reason": "nonfinite_gradient_norm",
                })
            objective_history.append(objective)
            iterations = iteration + 1
            if gradient_norm <= gradient_tolerance:
                numerically_converged = True
                termination_reason = "gradient_tolerance"
                break
            step = margin_sd * margin_sd
            accepted = False
            while step >= 1e-12:
                trial = {
                    team: ratings[team] - step * gradient[team] for team in teams}
                for component in components:
                    mean = sum(trial[team] for team in component) / len(component)
                    for team in component:
                        trial[team] -= mean
                trial_objective = evaluate(trial)[2]
                if (math.isfinite(trial_objective)
                        and trial_objective <= objective
                        - 1e-4 * step * gradient_norm * gradient_norm):
                    ratings = trial
                    accepted = True
                    break
                step *= 0.5
            if not accepted:
                termination_reason = "line_search_stalled"
                numerically_converged = gradient_norm <= max(
                    gradient_tolerance, 1e-8)
                break
    except (ArithmeticError, OverflowError) as error:
        return _failure("numerical_failure", {"error": str(error)})

    expectations, residuals, objective, gradient = evaluate(ratings)
    adjustments = {
        team: expectations[team] - targets[team] for team in teams}
    max_error = max((abs(value) for value in adjustments.values()), default=0.0)
    probability_adjustments = {
        team: adjustments[team] / games_by_team[team] if games_by_team[team] else 0.0
        for team in teams
    }
    max_probability_error = max(map(abs, probability_adjustments.values()), default=0.0)
    compatibility = max_probability_error <= publication_tolerance and not invalid_targets
    available_wins = float(len(games))
    raw_total = sum(targets.values())
    schedule_status = (
        "completed" if not games else
        "disconnected" if len(components) > 1 else
        "connected"
    )
    return {
        "status": "ok" if numerically_converged and not invalid_targets else "failed",
        "candidate": "schedule-feasible-rating-fit-v1",
        "review_only": True,
        "schedule": {
            "status": schedule_status,
            "remaining_game_count": len(games),
            "available_remaining_wins": available_wins,
            "components": components,
            "component_conservation": component_conservation,
            "unidentified_relative_strengths": len(components) > 1,
            "cross_component_identifiability": (
                "relative rating strength between disconnected components is unidentified"
                if len(components) > 1 else "identified_by_connected_schedule"
            ),
            "identifiability_notes": unidentified,
        },
        "weighting": {
            "basis": weighting_basis,
            "weights": weights,
        },
        "raw_targets": targets,
        "raw_target_total": raw_total,
        "raw_total_minus_available_wins": raw_total - available_wins,
        "fitted_expectations": expectations,
        "ratings": ratings,
        "adjustments": adjustments,
        "probability_adjustments": probability_adjustments,
        "absolute_adjustment_total": sum(abs(value) for value in adjustments.values()),
        "fit": {
            "weighted_squared_error": 2.0 * objective,
            "max_absolute_error": max_error,
            "max_absolute_probability_error": max_probability_error,
            "gradient_norm": math.sqrt(sum(value * value for value in gradient.values())),
            "invalid_target_teams": invalid_targets,
        },
        "input_validation": {
            "passed": not invalid_targets,
            "invalid_target_teams": invalid_targets,
        },
        "termination": {
            "reason": termination_reason,
            "numerically_converged": numerically_converged,
            "iterations": iterations,
        },
        "market_compatibility": {
            "status": "compatible" if compatibility else "incompatible",
            "publication_tolerance": publication_tolerance,
            "tolerance_units": "remaining_win_probability_per_scheduled_game",
            "passed": compatibility,
        },
        "assumptions": {
            "one_win_per_remaining_game": True,
            "hfa_points": hfa,
            "margin_sd": margin_sd,
            "raw_targets_preserved": True,
            "official_model_unchanged": True,
        },
        "diagnostics": {
            "objective_start": objective_history[0] if objective_history else objective,
            "objective_end": objective,
        },
    }
