"""Deterministic, review-only joint calibration of legal NFL scenarios.

This module deliberately operates on a *scenario library*, rather than making
up new outcomes.  A scenario is a dictionary containing a stable ``id`` and a
``metrics`` dictionary.  The metrics may be probabilities (for example
``wins:KC>=10`` or ``stage:KC:berth``), or any other scalar quantity for which
an evidence interval is available.

The fitted path probabilities minimize

    KL(weights || prior) + sum(reliability * interval_distance**2)

on the simplex.  Interval penalties are zero inside their accepted market
interval.  This is intentionally a small dependency-free solver: the
exponentiated-gradient update is deterministic, and scipy is not required.
The optional scipy import is not used on purpose; review results must not
change merely because scipy happens to be installed on one worker.

The production simulator does not import this module.  Callers must opt in to
the review path explicitly.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

import numpy as np


class JointFitError(ValueError):
    """Raised for malformed review input, before optimization starts."""


@dataclass(frozen=True)
class IntervalEvidence:
    """One accepted interval for an expected scenario metric."""

    name: str
    metric: str
    lower: float
    upper: float
    reliability: float = 1.0
    group: str = "default"
    precision: float | None = None
    resolved: bool = False

    def __post_init__(self) -> None:
        if not self.name or not self.metric:
            raise JointFitError("evidence name and metric are required")
        if not (math.isfinite(self.lower) and math.isfinite(self.upper)):
            raise JointFitError(f"non-finite interval for {self.name}")
        if self.lower > self.upper:
            raise JointFitError(f"reversed interval for {self.name}")
        if self.reliability < 0 or not math.isfinite(self.reliability):
            raise JointFitError(f"invalid reliability for {self.name}")
        if self.precision is not None and (
            self.precision < 0 or not math.isfinite(self.precision)
        ):
            raise JointFitError(f"invalid precision for {self.name}")


def _metric_value(scenario: Mapping[str, Any], metric: str) -> float | None:
    """Read common scenario encodings without making scenario generation here."""
    metrics = scenario.get("metrics", {})
    if isinstance(metrics, Mapping) and metric in metrics:
        value = metrics[metric]
        try:
            return float(value)
        except (TypeError, ValueError):
            # String-valued facts are useful for filtering resolved games;
            # numeric evidence is validated by the matrix construction below.
            return value  # type: ignore[return-value]
    # A few convenient aliases keep fixtures readable while the canonical
    # metric names remain explicit in diagnostics.
    aliases = [metric]
    if metric.startswith("stage:"):
        _, team, stage = metric.split(":", 2)
        aliases += [f"{team}:{stage}", f"{stage}:{team}"]
        for key in ("stages", "advancement", "stage_probs"):
            values = scenario.get(key)
            if isinstance(values, Mapping):
                if isinstance(values.get(team), Mapping) and stage in values[team]:
                    return float(values[team][stage])
    if metric.startswith("no_playoffs:"):
        team = metric.split(":", 1)[1]
        for key in ("stages", "advancement", "stage_probs"):
            values = scenario.get(key)
            if isinstance(values, Mapping) and isinstance(values.get(team), Mapping):
                if "berth" in values[team]:
                    return 1.0 - float(values[team]["berth"])
    if metric.startswith("wins:"):
        parts = metric.split(":", 2)
        team = parts[1]
        rung = parts[2] if len(parts) == 3 else None
        wins = scenario.get("wins")
        if isinstance(wins, Mapping) and team in wins:
            if rung is None:
                return float(wins[team])
            aliases += [f"{team}:wins>={rung}", f"wins>={rung}:{team}"]
            return float(float(wins[team]) >= float(rung))
    if metric.startswith("payout:"):
        team = metric.split(":", 1)[1]
        values = scenario.get("payout", {})
        if isinstance(values, Mapping) and team in values:
            return float(values[team])
    if metric.startswith("game:"):
        parts = metric.split(":", 2)
        outcomes = scenario.get("outcomes", {})
        if len(parts) == 3 and isinstance(outcomes, Mapping):
            return float(outcomes.get(parts[1]) == parts[2])
    for alias in aliases:
        if isinstance(metrics, Mapping) and alias in metrics:
            return float(metrics[alias])
    return None


def _fact_value(scenario: Mapping[str, Any], metric: str) -> float | None:
    value = _metric_value(scenario, metric)
    if value is not None:
        return value
    facts = scenario.get("facts", {})
    if isinstance(facts, Mapping) and metric in facts:
        return float(facts[metric])
    return None


def _as_evidence(row: IntervalEvidence | Mapping[str, Any], index: int) -> IntervalEvidence:
    if isinstance(row, IntervalEvidence):
        return row
    if not isinstance(row, Mapping):
        raise JointFitError(f"evidence {index} is not an object")
    lower = row.get("lower", row.get("accepted_lower"))
    upper = row.get("upper", row.get("accepted_upper"))
    interval = row.get("accepted_interval", row.get("interval"))
    if (lower is None or upper is None) and isinstance(interval, (list, tuple)) and len(interval) == 2:
        lower, upper = interval
    if lower is None or upper is None:
        # A point target is useful for resolved facts and synthetic fixtures.
        target = row.get("target")
        if target is None:
            raise JointFitError(f"evidence {index} has no interval")
        lower = upper = target
    return IntervalEvidence(
        name=str(row.get("name", row.get("id", f"evidence-{index}"))),
        metric=str(row.get("metric", row.get("key", ""))),
        lower=float(lower),
        upper=float(upper),
        reliability=float(row.get("reliability", row.get("weight", 1.0))),
        group=str(row.get("group", row.get("evidence_group", "default"))),
        precision=(None if row.get("precision") is None else float(row["precision"])),
        resolved=bool(row.get("resolved", row.get("hard", False))),
    )


def _scenario_facts(scenario: Mapping[str, Any]) -> Mapping[str, Any]:
    facts = scenario.get("resolved_facts", {})
    return facts if isinstance(facts, Mapping) else {}


def _fact_matches(scenario: Mapping[str, Any], key: str, expected: Any) -> bool:
    actual = _fact_value(scenario, key)
    if actual is None:
        actual = _scenario_facts(scenario).get(key)
    if actual is None:
        return False
    if isinstance(expected, bool):
        return bool(actual) == expected
    try:
        return abs(float(actual) - float(expected)) <= 1e-12
    except (TypeError, ValueError):
        return actual == expected


def _normalise_facts(facts: Mapping[str, Any] | Iterable[Mapping[str, Any]] | None) -> dict[str, Any]:
    if facts is None:
        return {}
    if isinstance(facts, Mapping):
        return {str(k): v for k, v in sorted(facts.items(), key=lambda item: str(item[0]))}
    result = {}
    for row in facts:
        if not isinstance(row, Mapping) or "metric" not in row or "value" not in row:
            raise JointFitError("resolved facts must contain metric and value")
        result[str(row["metric"])] = row["value"]
    return dict(sorted(result.items()))


def _prepare_scenarios(
    scenarios: Iterable[Mapping[str, Any]],
    facts: Mapping[str, Any],
) -> tuple[list[Mapping[str, Any]], np.ndarray, list[str], list[dict[str, Any]]]:
    prepared = []
    rejected = []
    for index, row in enumerate(scenarios):
        if not isinstance(row, Mapping):
            raise JointFitError(f"scenario {index} is not an object")
        if row.get("legal", True) is False:
            rejected.append({"scenario": str(row.get("id", index)), "reason": "illegal"})
            continue
        sid = str(row.get("id", row.get("scenario_id", index)))
        if not all(_fact_matches(row, key, value) for key, value in facts.items()):
            rejected.append({"scenario": sid, "reason": "resolved_fact"})
            continue
        prior = float(row.get("prior_weight", row.get("prior", 1.0)))
        if not math.isfinite(prior) or prior < 0:
            raise JointFitError(f"invalid prior weight for scenario {sid}")
        prepared.append((sid, row, prior))
    # Stable IDs are required even when a caller supplied scenarios in a
    # different order.  Duplicate IDs are almost always a fixture/data error.
    prepared.sort(key=lambda item: item[0])
    if len({item[0] for item in prepared}) != len(prepared):
        raise JointFitError("scenario ids must be unique")
    if not prepared:
        raise JointFitError("no legal scenario remains after resolved facts")
    ids = [item[0] for item in prepared]
    priors = np.asarray([item[2] for item in prepared], dtype=np.float64)
    if not np.any(priors > 0):
        raise JointFitError("legal scenarios have zero prior support")
    priors /= np.sum(priors, dtype=np.float64)
    return [item[1] for item in prepared], priors, ids, rejected


def _group_reliabilities(
    evidence: list[IntervalEvidence],
    precision_caps: Mapping[str, float] | None,
) -> tuple[np.ndarray, dict[str, float]]:
    """Apply reliability-weighted group precision caps in stable evidence order."""
    caps = {str(k): float(v) for k, v in (precision_caps or {}).items()}
    for group, cap in caps.items():
        if cap < 0 or not math.isfinite(cap):
            raise JointFitError(f"invalid precision cap for evidence group {group}")
    result = np.asarray(
        [float(row.precision if row.precision is not None else
               1.0 / max(row.upper - row.lower, 1e-6))
         * float(row.reliability) for row in evidence], dtype=np.float64)
    used: dict[str, float] = {}
    for group in sorted({row.group for row in evidence}):
        indices = [i for i, row in enumerate(evidence) if row.group == group]
        total = float(np.sum(result[indices], dtype=np.float64))
        cap = caps.get(group)
        scale = min(1.0, cap / total) if cap is not None and total > 0 else 1.0
        for i in indices:
            result[i] *= scale
        used[group] = float(np.sum(result[indices], dtype=np.float64))
    return result, used


def fit_joint_weights(
    scenarios: Iterable[Mapping[str, Any]],
    evidence: Iterable[IntervalEvidence | Mapping[str, Any]],
    *,
    resolved_facts: Mapping[str, Any] | Iterable[Mapping[str, Any]] | None = None,
    precision_caps: Mapping[str, float] | None = None,
    max_iterations: int = 2000,
    tolerance: float = 1e-9,
    learning_rate: float = 0.2,
    max_seconds: float | None = None,
) -> dict[str, Any]:
    """Fit normalized scenario weights and return a fully auditable result.

    A failed or timed-out solve is returned with ``status == "failed"`` and
    diagnostics; callers should never publish such a result.
    """
    started = time.monotonic()
    if max_iterations <= 0 or tolerance <= 0 or learning_rate <= 0:
        raise JointFitError("solver settings must be positive")
    facts = _normalise_facts(resolved_facts)
    rows = [_as_evidence(row, i) for i, row in enumerate(evidence)]
    rows.sort(key=lambda row: (row.group, row.name, row.metric))
    if not rows:
        raise JointFitError("at least one evidence interval is required")
    # Identical observations can appear once per quote refresh.  Retain the
    # strongest copy rather than treating a repeated observation as new
    # confidence.  Distinct intervals remain separate evidence.
    unique: dict[tuple[str, float, float, str], IntervalEvidence] = {}
    for row in rows:
        key = (row.metric, row.lower, row.upper, row.group)
        old = unique.get(key)
        if old is None or (row.reliability, row.precision or 0.0) > (
            old.reliability, old.precision or 0.0
        ):
            unique[key] = row
    rows = sorted(unique.values(), key=lambda row: (row.group, row.name, row.metric))
    # Settlements are facts, not noisy market observations.  A resolved
    # interval therefore removes every path that disagrees with its exact
    # 0/1 value before fitting; it never enters the KL/penalty objective.
    hard_facts = {
        row.metric: row.lower for row in rows
        if row.resolved and abs(row.lower - row.upper) <= tolerance
    }
    facts = {**facts, **hard_facts}
    prepared, prior, ids, rejected = _prepare_scenarios(scenarios, facts)
    interval_conflicts = []
    for i, left in enumerate(rows):
        for right in rows[i + 1:]:
            if left.metric != right.metric:
                continue
            if left.upper < right.lower or right.upper < left.lower:
                interval_conflicts.append({
                    "metric": left.metric,
                    "evidence": [left.name, right.name],
                    "intervals": [[left.lower, left.upper], [right.lower, right.upper]],
                })

    matrix = np.empty((len(rows), len(prepared)), dtype=np.float64)
    support_failures = []
    for ei, row in enumerate(rows):
        values = [_metric_value(scenario, row.metric) for scenario in prepared]
        missing = [ids[i] for i, value in enumerate(values) if value is None]
        if missing:
            raise JointFitError(
                f"evidence {row.name} is missing from scenarios: {', '.join(missing[:3])}"
            )
        matrix[ei] = np.asarray(values, dtype=np.float64)
        lo, hi = float(np.min(matrix[ei])), float(np.max(matrix[ei]))
        if row.upper < lo - tolerance or row.lower > hi + tolerance:
            support_failures.append({
                "evidence": row.name, "metric": row.metric,
                "accepted_interval": [row.lower, row.upper],
                "scenario_support": [lo, hi],
            })

    precision, group_precision = _group_reliabilities(rows, precision_caps)
    weights = prior.copy()
    converged = False
    iterations = 0

    def loss_parts(current: np.ndarray) -> tuple[float, float]:
        kl = float(np.sum(np.where(
            current > 0, current * np.log(np.maximum(current, 1e-300) / prior), 0.0),
            dtype=np.float64))
        achieved = matrix @ current
        penalty = 0.0
        for i, row in enumerate(rows):
            residual = max(row.lower - achieved[i], 0.0, achieved[i] - row.upper)
            penalty += float(precision[i]) * residual * residual
        return kl, penalty

    status = "max_iterations"
    stalled = 0
    for iteration in range(1, max_iterations + 1):
        iterations = iteration
        if max_seconds is not None and time.monotonic() - started >= max_seconds:
            status = "timeout"
            break
        achieved = matrix @ weights
        outside = np.where(achieved < np.asarray([r.lower for r in rows]), -1,
                           np.where(achieved > np.asarray([r.upper for r in rows]), 1, 0))
        # Gradient of KL plus squared hinge interval penalties.
        gradient = np.log(np.maximum(weights, 1e-300) / prior) + 1.0
        for i in range(len(rows)):
            if outside[i]:
                residual = achieved[i] - (
                    rows[i].lower if outside[i] < 0 else rows[i].upper
                )
                gradient += 2.0 * precision[i] * residual * matrix[i]
        # Mirror descent keeps every weight nonnegative and exactly normalized.
        # Backtracking is deterministic and prevents a high-reliability quote
        # from making a fixed mirror step jump from one side of an interval to
        # the other.  It also makes the default settings well behaved for both
        # binary advancement indicators and point-valued metrics.
        old_kl, old_penalty = loss_parts(weights)
        old_loss = old_kl + old_penalty
        step = learning_rate
        updated = weights
        while step >= 1e-12:
            log_update = np.log(np.maximum(weights, 1e-300)) - step * gradient
            log_update -= np.max(log_update)
            candidate = np.exp(log_update)
            candidate /= np.sum(candidate, dtype=np.float64)
            candidate_kl, candidate_penalty = loss_parts(candidate)
            updated = candidate
            if candidate_kl + candidate_penalty <= old_loss + 1e-15:
                break
            step *= 0.5
        delta = float(np.max(np.abs(updated - weights)))
        new_kl, new_penalty = loss_parts(updated)
        if abs((new_kl + new_penalty) - old_loss) <= max(tolerance * 0.1, 1e-14):
            stalled += 1
        else:
            stalled = 0
        weights = updated
        if delta <= tolerance or stalled >= 3:
            converged = True
            status = "converged"
            break
    else:
        status = "converged" if converged else "max_iterations"

    achieved = matrix @ weights
    residuals = []
    for i, row in enumerate(rows):
        distance = (
            row.lower - achieved[i] if achieved[i] < row.lower else
            achieved[i] - row.upper if achieved[i] > row.upper else 0.0
        )
        residuals.append({
            "name": row.name, "metric": row.metric, "group": row.group,
            "accepted_interval": [row.lower, row.upper],
            "achieved": float(achieved[i]), "residual": float(distance),
            "inside_interval": abs(distance) <= tolerance,
            "reliability": row.reliability, "effective_precision": float(precision[i]),
        })
    kl, penalty = loss_parts(weights)
    diagnostics = {
        "loss_breakdown": {"kl_prior": kl, "interval_penalty": penalty,
                           "total": kl + penalty},
        "interval_residuals": residuals,
        "effective_sample_size": float(1.0 / np.sum(np.square(weights))),
        "max_weight": float(np.max(weights)),
        "support_failures": support_failures,
        "interval_conflicts": interval_conflicts,
        "rejected_scenarios": rejected,
        "solver_status": {
            "status": status, "iterations": iterations, "converged": converged,
            "max_iterations": max_iterations, "tolerance": tolerance,
            "learning_rate": learning_rate,
        },
        "evidence_group_precision": group_precision,
        "resolved_facts": facts,
        "scenario_count": len(prepared),
        "hard_settlement_count": len(hard_facts),
    }
    if support_failures:
        status = "failed"
        diagnostics["solver_status"]["status"] = "unsupported_interval"
    elif interval_conflicts:
        status = "failed"
        diagnostics["solver_status"]["status"] = "conflicting_intervals"
    elif any(abs(row["residual"]) > tolerance for row in residuals):
        status = "failed"
        diagnostics["solver_status"]["status"] = "interval_residual"
    elif status != "converged":
        status = "failed"
    return {
        "status": status,
        "weights": {sid: float(weights[i]) for i, sid in enumerate(ids)},
        "scenario_ids": ids,
        "expected_metrics": {
            row.metric: float(achieved[i]) for i, row in enumerate(rows)
        },
        "diagnostics": diagnostics,
    }


def constraints_from_state(
    state: Mapping[str, Any],
    *,
    min_reliability: float = 0.0,
) -> list[dict[str, Any]]:
    """Convert explicit review evidence in state into canonical constraints.

    This intentionally consumes only ``joint_fit_constraints``.  Guessing
    intervals from production bid/ask fields would make review runs silently
    depend on quote schema changes.
    """
    rows = state.get("joint_fit_constraints", [])
    if not isinstance(rows, list):
        raise JointFitError("joint_fit_constraints must be a list")
    return [
        dict(row, reliability=max(float(row.get("reliability", 1.0)), min_reliability))
        for row in rows
        if isinstance(row, Mapping)
    ]


def scenarios_from_path_library(
    path_library: Iterable[Mapping[str, Any]],
    *,
    teams: Iterable[str] | None = None,
    realized: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Expose settlement indicators from ``simulate.monte_carlo`` paths.

    The simulator's path objects intentionally use compact nested fields.
    Review fitting gets stable metric names for every win rung and advancement
    stage, while retaining outcomes and payout columns for reconciliation.
    """
    path_rows = list(path_library)
    team_names = sorted(set(teams or ()) | {
        str(team) for row in path_rows
        for team in (row.get("wins", {}) if isinstance(row, Mapping) else {})
    })
    rows = []
    for index, source in enumerate(path_rows):
        if not isinstance(source, Mapping):
            raise JointFitError(f"path {index} is not an object")
        wins = source.get("wins", {})
        advancement = source.get("advancement", source.get("stages", {}))
        metrics = dict(source.get("metrics", {}))
        for team in team_names:
            total = float(wins.get(team, 0)) if isinstance(wins, Mapping) else 0.0
            for strike in range(0, 18):
                metrics[f"wins:{team}:{strike}"] = float(total >= strike)
            values = advancement.get(team, {}) if isinstance(advancement, Mapping) else {}
            if isinstance(values, Mapping):
                for stage, value in sorted(values.items()):
                    metrics[f"stage:{team}:{stage}"] = float(value)
                if "berth" in values:
                    metrics[f"no_playoffs:{team}"] = 1.0 - float(values["berth"])
        outcomes = source.get("outcomes", {})
        if isinstance(outcomes, Mapping):
            for game, outcome in sorted(outcomes.items(), key=lambda item: str(item[0])):
                metrics[f"game:{game}:{outcome}"] = 1.0
        row = {
            "id": str(source.get("id", f"path-{index:08d}")),
            "prior_weight": float(source.get("prior_weight", source.get("weight", 1.0))),
            "metrics": metrics,
            "wins": dict(wins) if isinstance(wins, Mapping) else {},
            "advancement": dict(advancement) if isinstance(advancement, Mapping) else {},
            "outcomes": dict(outcomes) if isinstance(outcomes, Mapping) else {},
            "payout": dict(source.get("payout", {})),
            "legal": source.get("legal", True),
        }
        if realized:
            row["actuals"] = {
                team: float(value.get("wins", value) if isinstance(value, Mapping) else value)
                for team, value in sorted(realized.items())
            }
            for team, value in row["actuals"].items():
                row["metrics"][f"actual:wins:{team}"] = value
        rows.append(row)
    return rows


def constraints_from_markets(
    state: Mapping[str, Any],
    *,
    interval_tolerance: float = 0.03,
) -> list[dict[str, Any]]:
    """Build joint win/advancement evidence from the existing quote shape."""
    result: list[dict[str, Any]] = []
    for team in sorted(state.get("win_ladders", {})):
        for row in state["win_ladders"][team]:
            strike = row.get("strike")
            if strike is None:
                continue
            settled = str(row.get("status", "")).lower() in {"finalized", "settled"} or row.get("result") in {"yes", "no"}
            if settled:
                value = 1.0 if row.get("result") == "yes" else 0.0
                lower = upper = value
                resolved = True
            else:
                bid, ask = row.get("yes_bid"), row.get("yes_ask")
                if bid is None and ask is None:
                    continue
                lower = float(bid) if bid is not None else 0.0
                upper = float(ask) if ask is not None else 1.0
                resolved = False
            width = upper - lower
            result.append({
                "name": f"wins-{team}-{strike}", "metric": f"wins:{team}:{strike}",
                "lower": lower, "upper": upper, "group": f"wins:{team}",
                "reliability": float(row.get("reliability", 1.0)),
                "precision": 0.0 if resolved else 1.0 / max(width, 0.01),
                "resolved": resolved,
            })
    stages = {"berth", "divisional", "conference", "sb_berth", "sb_win"}
    elimination_to_stage = {
        "wild_card": "berth", "divisional": "divisional",
        "conference": "conference", "sb_loss": "sb_berth", "sb_win": "sb_win",
    }
    for team in sorted(state.get("elimination_quotes", {})):
        for label, quote in sorted(state["elimination_quotes"][team].items()):
            settled = isinstance(quote, Mapping) and (
                str(quote.get("status", "")).lower() in {"settled", "finalized"}
                or quote.get("settlement") in {"yes", "no"}
            )
            one_sided = False
            if isinstance(quote, Mapping):
                value = (
                    1.0 if quote.get("settlement") == "yes" else
                    0.0 if quote.get("settlement") == "no" else
                    quote.get("mid", quote.get("value", quote.get("yes_bid")))
                )
                spread = abs(float(quote.get("spread", interval_tolerance)))
                if not settled and (
                    quote.get("yes_bid") is not None or quote.get("yes_ask") is not None
                ):
                    lower = float(quote["yes_bid"]) if quote.get("yes_bid") is not None else 0.0
                    upper = float(quote["yes_ask"]) if quote.get("yes_ask") is not None else 1.0
                    one_sided = quote.get("yes_bid") is None or quote.get("yes_ask") is None
            else:
                value, spread = quote, interval_tolerance
            if value is None:
                continue
            metric = (
                f"no_playoffs:{team}" if label == "no_playoffs"
                else f"stage:{team}:{label}" if label in stages
                else f"stage:{team}:{elimination_to_stage[label]}"
                if label in elimination_to_stage
                else None
            )
            if metric is None:
                continue
            if settled:
                lower = upper = float(value)
            elif not one_sided:
                lower = max(0.0, float(value) - spread)
                upper = min(1.0, float(value) + spread)
            result.append({
                "name": f"advancement-{team}-{label}", "metric": metric,
                "lower": lower, "upper": upper,
                "group": f"advancement:{team}", "reliability": 1.0,
                "precision": 0.0 if settled else 1.0 / max(upper - lower, 0.01),
                "resolved": settled,
            })
    return result


def summarize_path_library(
    scenarios: Iterable[Mapping[str, Any]],
    weights: Mapping[str, float],
    *,
    pool: float | None = None,
) -> dict[str, Any]:
    """Compute weighted payout and conditional summaries after fitting."""
    rows = sorted(scenarios, key=lambda row: str(row.get("id", "")))
    weight = np.asarray([float(weights.get(str(row.get("id", "")), 0.0)) for row in rows])
    total = float(np.sum(weight, dtype=np.float64))
    payout_teams = sorted({
        str(team) for row in rows for team in (row.get("payout", {}) or {})
    })
    payout = {}
    for team in payout_teams:
        payout[team] = float(sum(
            weight[i] * float(rows[i].get("payout", {}).get(team, 0.0))
            for i in range(len(rows))
        ) / total) if total else 0.0
    conditionals: dict[str, Any] = {}
    outcome_keys = sorted({
        (str(game), str(outcome))
        for row in rows
        for game, outcome in (row.get("outcomes", {}) or {}).items()
    })
    for game, outcome in outcome_keys:
        selected = np.asarray([
            i for i, row in enumerate(rows)
            if str((row.get("outcomes", {}) or {}).get(game)) == outcome
        ], dtype=np.intp)
        sw = float(np.sum(weight[selected], dtype=np.float64)) if len(selected) else 0.0
        conditionals[f"{game}:{outcome}"] = {
            "game": game, "outcome": outcome,
            "probability": sw / total if total else 0.0,
            "sample_count": int(len(selected)),
            "effective_sample_size": (
                sw * sw / float(np.sum(np.square(weight[selected]), dtype=np.float64))
                if len(selected) and sw else 0.0
            ),
            "payout": {
                team: (
                    float(sum(
                        weight[i] * float(rows[i].get("payout", {}).get(team, 0.0))
                        for i in selected
                    ) / sw) if sw else None
                )
                for team in payout_teams
            },
        }
    reconciliation = {}
    for row in conditionals.values():
        reconciliation.setdefault(row["game"], 0.0)
        reconciliation[row["game"]] += row["probability"]
    coverage = {
        "scenario_count": len(rows), "weighted_path_mass": total,
        "payout_team_count": len(payout_teams),
        "pool": pool, "payout_total": sum(payout.values()),
        "pool_error": (sum(payout.values()) - pool) if pool is not None else None,
    }
    return {
        "payout": payout, "conditionals": conditionals,
        "conditional_reconciliation": reconciliation, "coverage": coverage,
    }


# Descriptive aliases make the review API easy to discover without creating a
# second implementation (and preserve one deterministic solver entrypoint).
joint_constrained_fit = fit_joint_weights
fit_scenario_weights = fit_joint_weights
