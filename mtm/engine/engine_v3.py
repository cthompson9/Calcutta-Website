"""Review-only generative NFL Monte Carlo engine.

The production engine does not import this module.  V3 moves uncertainty into
one latent strength draw per team and simulated universe.  Adaptive proposal
worlds shift that latent draw and are combined with ordinary worlds using the
exact base-density / mixture-density likelihood ratio.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Any

STAGES = ("berth", "divisional", "conference", "sb_berth", "sb_win")


@dataclass(frozen=True)
class Game:
    home: str
    away: str
    week: int = 0
    marquee: bool = False
    event_id: int | None = None


def _phi(x: float) -> float:
    return .5 * (1 + math.erf(x / math.sqrt(2)))


def blend_playoff_futures(base: dict[str, float],
                          targets: dict[str, dict[str, float]],
                          scale: float) -> dict[str, float]:
    """Add a centered, bounded futures signal to schedule-fitted ratings."""
    if not targets or scale == 0:
        return dict(base)
    scores = {}
    stage_weight = {"berth": .35, "divisional": .2, "conference": .15,
                    "sb_berth": .15, "sb_win": .15}
    for team in base:
        score = 0.0
        for stage, weight in stage_weight.items():
            p = min(max(float(targets[team][stage]), 1e-4), 1 - 1e-4)
            score += weight * math.log(p / (1 - p))
        scores[team] = score
    mean = sum(scores.values()) / len(scores)
    centered = {t: scores[t] - mean for t in scores}
    rms = math.sqrt(sum(v * v for v in centered.values()) / len(centered)) or 1.0
    adjusted = {t: base[t] + scale * centered[t] / rms for t in base}
    adjusted_mean = sum(adjusted.values()) / len(adjusted)
    return {t: adjusted[t] - adjusted_mean for t in adjusted}


def validate_state(teams: list[str], divisions: dict[str, list[str]],
                   games: list[Game], completed: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    if len(teams) != 32 or len(set(teams)) != 32:
        errors.append("NFL v3 requires exactly 32 unique teams")
    members = [t for group in divisions.values() for t in group]
    if len(divisions) != 8 or any(len(group) != 4 for group in divisions.values()):
        errors.append("NFL v3 requires eight four-team divisions")
    if len(members) != 32 or set(members) != set(teams):
        errors.append("division membership does not match the 32 teams")
    if any(g.home == g.away or g.home not in teams or g.away not in teams for g in games):
        errors.append("remaining schedule contains an invalid matchup")
    for row in completed:
        if row.get("home") not in teams or row.get("away") not in teams:
            errors.append("completed schedule contains an unknown team")
            break
    return errors


def _conference(division: str) -> str:
    return division.split()[0].upper()


def _pct(wins: float, losses: float, ties: float) -> float:
    games = wins + losses + ties
    return (wins + .5 * ties) / games if games else 0.0


def _add_record(record: list[float], outcome: str) -> None:
    record[{"win": 0, "loss": 1, "tie": 2}[outcome]] += 1


def build_tiebreak_context(teams: list[str], records: list[dict[str, Any]],
                           divisions: dict[str, list[str]],
                           point_diff: dict[str, float]) -> dict[str, Any]:
    div_of = {t: d for d, group in divisions.items() for t in group}
    conf_of = {t: _conference(div_of[t]) for t in teams}
    overall = {t: [0.0, 0.0, 0.0] for t in teams}
    division = {t: [0.0, 0.0, 0.0] for t in teams}
    conference = {t: [0.0, 0.0, 0.0] for t in teams}
    by_opponent = {t: {} for t in teams}
    for row in records:
        home, away = row["home"], row["away"]
        by_opponent[home].setdefault(away, [0.0, 0.0, 0.0])
        by_opponent[away].setdefault(home, [0.0, 0.0, 0.0])
        if row["outcome"] == "tie":
            home_outcome = away_outcome = "tie"
        else:
            home_outcome = "win" if row["winner"] == home else "loss"
            away_outcome = "win" if row["winner"] == away else "loss"
        for team, opponent, outcome in (
            (home, away, home_outcome), (away, home, away_outcome)
        ):
            _add_record(overall[team], outcome)
            _add_record(by_opponent[team][opponent], outcome)
            if div_of[team] == div_of[opponent]:
                _add_record(division[team], outcome)
            if conf_of[team] == conf_of[opponent]:
                _add_record(conference[team], outcome)
    overall_pct = {t: _pct(*overall[t]) for t in teams}
    strength_victory = {}
    strength_schedule = {}
    for team in teams:
        opponents = by_opponent[team]
        total_games = sum(sum(record) for record in opponents.values())
        wins = sum(record[0] for record in opponents.values())
        strength_schedule[team] = (
            sum(sum(record) * overall_pct[opponent]
                for opponent, record in opponents.items()) / total_games
            if total_games else 0.0
        )
        strength_victory[team] = (
            sum(record[0] * overall_pct[opponent]
                for opponent, record in opponents.items()) / wins
            if wins else 0.0
        )
    return {
        "div_of": div_of, "overall": overall, "overall_pct": overall_pct,
        "division": division, "conference": conference,
        "by_opponent": by_opponent, "strength_victory": strength_victory,
        "strength_schedule": strength_schedule, "point_diff": point_diff,
    }


def rank_teams(candidates: list[str], context: dict[str, Any]) -> list[str]:
    """Deterministic approximation of the NFL's available-data hierarchy.

    Applies overall record, head-to-head, division record when applicable,
    common games, conference record, strength of victory, strength of schedule,
    point differential, then stable team code.  The final code criterion is an
    explicit deterministic substitute for coin toss.
    """
    if len(candidates) <= 1:
        return candidates
    div_of = context["div_of"]
    grouped: dict[float, list[str]] = {}
    for team in candidates:
        grouped.setdefault(context["overall_pct"][team], []).append(team)
    ordered = []
    for overall_pct in sorted(grouped, reverse=True):
        tied = grouped[overall_pct]
        if len(tied) == 1:
            ordered.extend(tied)
            continue
        common_opponents = set.intersection(*(
            set(context["by_opponent"][t]) for t in tied
        ))
        same_division = len({div_of[t] for t in tied}) == 1

        def aggregate(team: str, opponents: set[str]) -> tuple[float, float, float]:
            records = [context["by_opponent"][team].get(o, [0.0, 0.0, 0.0])
                       for o in opponents]
            return tuple(sum(record[i] for record in records)
                         for i in range(3))

        def key(team: str) -> tuple[float, ...]:
            h2h = _pct(*aggregate(team, set(tied) - {team}))
            common = _pct(*aggregate(team, common_opponents))
            return (
                h2h,
                _pct(*context["division"][team]) if same_division else 0.0,
                common if len(common_opponents) >= 4 else 0.0,
                _pct(*context["conference"][team]),
                context["strength_victory"][team],
                context["strength_schedule"][team],
                context["point_diff"][team],
            )

        # Stable ascending code is the deterministic coin-toss substitute.
        ordered.extend(sorted(sorted(tied), key=key, reverse=True))
    return ordered


def select_wildcards(candidates: list[str], context: dict[str, Any],
                     count: int = 3) -> list[str]:
    """Select wildcards procedurally, restarting after each berth."""
    remaining = list(candidates)
    selected = []
    div_of = context["div_of"]
    while remaining and len(selected) < count:
        best_pct = max(context["overall_pct"][team] for team in remaining)
        tied = [team for team in remaining if context["overall_pct"][team] == best_pct]
        by_division: dict[str, list[str]] = {}
        for team in tied:
            by_division.setdefault(div_of[team], []).append(team)
        reduced = [rank_teams(group, context)[0] for group in by_division.values()]
        winner = rank_teams(reduced, context)[0]
        selected.append(winner)
        remaining.remove(winner)
    return selected


def _play_game(a: str, b: str, home: str | None, latent: dict[str, float],
               hfa: float, margin_sd: float, tie_window: float,
               rng: random.Random) -> tuple[str, float]:
    mean = latent[a] - latent[b] + (hfa if home == a else -hfa if home == b else 0.0)
    margin = rng.gauss(mean, margin_sd)
    if abs(margin) <= tie_window:
        return "tie", 0.0
    return (a, margin) if margin > 0 else (b, margin)


def _conference_bracket(seeds: list[str], latent: dict[str, float], hfa: float,
                        margin_sd: float, rng: random.Random) -> dict[str, int]:
    reached = {t: 1 for t in seeds}

    def playoff(a: str, b: str, home: str) -> str:
        winner, margin = _play_game(a, b, home, latent, hfa, margin_sd, 0.0, rng)
        return winner if winner != "tie" else (a if margin >= 0 else b)

    survivors = [seeds[0],
                 playoff(seeds[1], seeds[6], seeds[1]),
                 playoff(seeds[2], seeds[5], seeds[2]),
                 playoff(seeds[3], seeds[4], seeds[3])]
    for t in survivors:
        reached[t] = 2
    survivors.sort(key=seeds.index)
    finalists = [playoff(survivors[0], survivors[3], survivors[0]),
                 playoff(survivors[1], survivors[2], survivors[1])]
    for t in finalists:
        reached[t] = 3
    finalists.sort(key=seeds.index)
    champion = playoff(finalists[0], finalists[1], finalists[0])
    reached[champion] = 4
    return reached


def _proposal_ratio_to_base(x: dict[str, float], means: dict[str, float],
                            strength_sd: float, proposals: list[tuple[str, float]],
                            mixture_fractions: list[float]) -> float:
    """Return q(x)/p(x) for a base-plus-one-team-shift Gaussian mixture."""
    ratio = mixture_fractions[0]
    variance = strength_sd * strength_sd
    for fraction, (team, shift) in zip(mixture_fractions[1:], proposals):
        # N(x; mu+shift,sd) / N(x; mu,sd)
        ratio += fraction * math.exp(
            shift * (x[team] - means[team]) / variance
            - .5 * shift * shift / variance
        )
    return ratio


def simulate_v3(*, ratings: dict[str, float], games: list[Game],
                completed_results: list[dict[str, Any]],
                realized: dict[str, dict[str, float]],
                divisions: dict[str, list[str]], rubric: dict, pot: float,
                playoff_targets: dict[str, dict[str, float]],
                runs: int, pilot_runs: int, seed: int, hfa: float,
                margin_sd: float, strength_sd: float, tie_window: float,
                proposal_shift: float, proposal_fraction: float,
                residual_trigger: float, min_target_hits: int,
                min_global_ess: float, max_team_mc_se: float,
                max_split_half_difference: float,
                min_conditional_ess: float,
                min_conditional_share: float,
                win_targets: dict[str, float],
                max_win_residual: float,
                 max_playoff_residual: float,
                 return_path_library: bool = False) -> dict:
    teams = sorted(ratings)
    errors = validate_state(teams, divisions, games, completed_results)
    if errors or runs <= 0 or pilot_runs < 0 or margin_sd <= 0 or strength_sd <= 0 or pot <= 0:
        return {"status": "failed", "error": "; ".join(errors or ["invalid simulation configuration"]),
                "diagnostics": {"validity_errors": errors}}
    rng = random.Random(seed)
    div_of = {t: d for d, group in divisions.items() for t in group}
    confs = sorted({_conference(d) for d in divisions})

    def one_world(proposal: tuple[str, float] | None) -> dict[str, Any]:
        latent = {t: rng.gauss(ratings[t], strength_sd) for t in teams}
        if proposal:
            latent[proposal[0]] += proposal[1]
        wins = {t: float(realized[t].get("wins", 0)) for t in teams}
        ties = {t: float(realized[t].get("ties", 0)) for t in teams}
        differential = {t: float(realized[t].get("adj_pt_diff", 0)) for t in teams}
        records = []
        for row in completed_results:
            home, away = row["home"], row["away"]
            hs, aws = float(row["home_score"]), float(row["away_score"])
            outcome = "tie" if hs == aws else "decided"
            records.append({"home": home, "away": away, "outcome": outcome,
                            "winner": "tie" if outcome == "tie" else home if hs > aws else away})
        outcomes: list[str] = []
        for game in games:
            winner, margin = _play_game(game.home, game.away, game.home, latent,
                                        hfa, margin_sd, tie_window, rng)
            if winner == "tie":
                ties[game.home] += 1
                ties[game.away] += 1
                outcomes.append("tie")
                records.append({"home": game.home, "away": game.away,
                                "outcome": "tie", "winner": "tie"})
            else:
                loser = game.away if winner == game.home else game.home
                wins[winner] += 1
                signed = abs(margin) if winner == game.home else -abs(margin)
                multiplier = 2 if game.marquee else 1
                differential[game.home] += signed * multiplier
                differential[game.away] -= signed * multiplier
                outcomes.append("home_win" if winner == game.home else "away_win")
                records.append({"home": game.home, "away": game.away,
                                "outcome": "decided", "winner": winner})
        path_stage = {t: {s: 0 for s in STAGES} for t in teams}
        tiebreak = build_tiebreak_context(teams, records, divisions, differential)
        conference_champions = []
        for conf in confs:
            division_winners = []
            for division, group in divisions.items():
                if _conference(division) == conf:
                    division_winners.append(rank_teams(group, tiebreak)[0])
            division_winners = rank_teams(division_winners, tiebreak)
            remaining = [t for t in teams if _conference(div_of[t]) == conf
                         and t not in division_winners]
            wildcards = select_wildcards(remaining, tiebreak, 3)
            seeds = division_winners + wildcards
            if len(seeds) != 7 or len(set(seeds)) != 7:
                raise ValueError(f"invalid {conf} playoff field")
            for t in seeds:
                path_stage[t]["berth"] = 1
            reached = _conference_bracket(seeds, latent, hfa, margin_sd, rng)
            for t, level in reached.items():
                if level >= 2:
                    path_stage[t]["divisional"] = 1
                if level >= 3:
                    path_stage[t]["conference"] = 1
                if level >= 4:
                    path_stage[t]["sb_berth"] = 1
            conference_champions.append(next(t for t, level in reached.items() if level == 4))
        sb_winner, _ = _play_game(conference_champions[0], conference_champions[1],
                                  None, latent, hfa, margin_sd, 0.0, rng)
        path_stage[sb_winner]["sb_win"] = 1
        points = {}
        for t in teams:
            value = float(rubric["banked"])
            value += float(rubric["per_win"]) * wins[t]
            value += float(rubric.get("per_tie", 0)) * ties[t]
            value += float(rubric["per_pt_diff"]) * differential[t]
            value += sum(float(rubric["bonuses"][s]) * path_stage[t][s] for s in STAGES)
            points[t] = value
        if any(not math.isfinite(v) for v in points.values()) or sum(points.values()) <= 0:
            raise ValueError("non-finite or non-positive Calcutta path")
        gross = {t: pot * points[t] / sum(points.values()) for t in teams}
        return {"latent": latent, "stage": path_stage, "gross": gross,
                "outcomes": outcomes, "wins": wins}

    pilot_hits = {t: {s: 0 for s in STAGES} for t in teams}
    for _ in range(pilot_runs):
        path = one_world(None)
        for t in teams:
            for stage in STAGES:
                pilot_hits[t][stage] += path["stage"][t][stage]
    pilot_probs = {t: {s: pilot_hits[t][s] / max(pilot_runs, 1) for s in STAGES}
                   for t in teams}
    deficits = {}
    for t in teams:
        positive = [s for s in STAGES if playoff_targets[t][s] > 0]
        deficits[t] = max((playoff_targets[t][s] - pilot_probs[t][s]
                           for s in positive), default=0.0)
    proposal_teams = [
        t for t in teams if any(
            playoff_targets[t][s] > 0 and (
                pilot_hits[t][s] < min_target_hits
                or playoff_targets[t][s] - pilot_probs[t][s] > residual_trigger
            ) for s in STAGES
        )
    ]
    proposal_teams.sort(key=lambda t: (-deficits[t], t))
    stage_shift_multiplier = {
        "berth": 1.0, "divisional": 1.25, "conference": 1.5,
        "sb_berth": 2.0, "sb_win": 2.5,
    }
    proposals = []
    for team in proposal_teams:
        unsupported_stages = [
            stage for stage in STAGES
            if playoff_targets[team][stage] > 0 and pilot_hits[team][stage] == 0
        ]
        multiplier = max(
            (stage_shift_multiplier[stage] for stage in unsupported_stages),
            default=1.0,
        )
        proposals.append((team, proposal_shift * multiplier))
    proposed_total = round(runs * proposal_fraction) if proposals else 0
    base_count = runs - proposed_total
    counts = [base_count]
    if proposals:
        each, remainder = divmod(proposed_total, len(proposals))
        counts.extend(each + (1 if i < remainder else 0) for i in range(len(proposals)))
    fractions = [count / runs for count in counts]

    paths = []
    for component, count in enumerate(counts):
        proposal = None if component == 0 else proposals[component - 1]
        for _ in range(count):
            path = one_world(proposal)
            mixture_ratio = _proposal_ratio_to_base(
                path["latent"], ratings, strength_sd, proposals, fractions)
            path["weight"] = 1.0 / max(mixture_ratio, 1e-300)
            path["component"] = "ordinary" if proposal is None else proposal[0]
            paths.append(path)

    # Components are generated in strata.  Shuffle once, deterministically, so
    # split-sample stability compares representative mixtures rather than the
    # ordinary stratum against the proposal strata.
    rng.shuffle(paths)
    total_weight = sum(p["weight"] for p in paths)
    weight_sq = sum(p["weight"] ** 2 for p in paths)
    ess = total_weight ** 2 / weight_sq if weight_sq else 0.0
    stage_probs = {t: {} for t in teams}
    residuals = []
    for t in teams:
        for stage in STAGES:
            simulated = sum(p["weight"] * p["stage"][t][stage] for p in paths) / total_weight
            stage_probs[t][stage] = simulated
            target = float(playoff_targets[t][stage])
            residuals.append({"team": t, "stage": stage, "target_probability": target,
                              "simulated_probability": simulated,
                              "residual": simulated - target})
    unsupported = [row for row in residuals
                   if row["target_probability"] > 0 and row["simulated_probability"] == 0]
    generated_wins = {
        t: sum(p["weight"] * p["wins"][t] for p in paths) / total_weight
        for t in teams
    }
    win_residuals = {
        t: generated_wins[t] - float(win_targets[t]) for t in teams
    }
    raw_stage_hits = {
        t: {stage: sum(p["stage"][t][stage] for p in paths) for stage in STAGES}
        for t in teams
    }
    payout = {}
    payout_se = {}
    payout_ci = {}
    stability = {}
    for t in teams:
        mean = sum(p["weight"] * p["gross"][t] for p in paths) / total_weight
        variance = sum(p["weight"] * (p["gross"][t] - mean) ** 2 for p in paths) / total_weight
        se = math.sqrt(max(variance, 0.0) / max(ess, 1.0))
        payout[t], payout_se[t] = mean, se
        payout_ci[t] = [mean - 1.96 * se, mean + 1.96 * se]
        halves = [paths[:len(paths)//2], paths[len(paths)//2:]]
        half_means = []
        for half in halves:
            hw = sum(p["weight"] for p in half)
            half_means.append(sum(p["weight"] * p["gross"][t] for p in half) / hw)
        stability[t] = abs(half_means[0] - half_means[1])
    conditionals: dict[str, Any] = {}
    for gi, game in enumerate(games):
        conditionals[str(gi)] = {"home": game.home, "away": game.away,
                                 "week": game.week, "event_id": game.event_id,
                                 "outcomes": {}}
        for outcome in ("home_win", "away_win", "tie"):
            selected = [p for p in paths if p["outcomes"][gi] == outcome]
            sw = sum(p["weight"] for p in selected)
            sw2 = sum(p["weight"] ** 2 for p in selected)
            conditional_ess = sw * sw / sw2 if sw2 else 0.0
            rows = {}
            for t in teams:
                mean = sum(p["weight"] * p["gross"][t] for p in selected) / sw if sw else None
                variance = (
                    sum(p["weight"] * (p["gross"][t] - mean) ** 2 for p in selected) / sw
                    if sw and mean is not None else None
                )
                rows[t] = {"gross_conditional": mean,
                           "gross_delta": None if mean is None else mean - payout[t],
                           "standard_error": (
                               math.sqrt(max(variance, 0.0) / max(conditional_ess, 1.0))
                               if variance is not None else None
                           )}
            share = sw / total_weight if total_weight else 0.0
            conditionals[str(gi)]["outcomes"][outcome] = {
                "probability": share,
                "sample_count": len(selected), "effective_sample_size": conditional_ess,
                "sample_share": share,
                "quality_status": (
                    "good" if conditional_ess >= min_conditional_ess
                    and share >= min_conditional_share else "insufficient"
                ),
                "teams": rows,
            }
    max_se = max(payout_se.values())
    max_stability_difference = max(stability.values())
    conditional_summary = {
        "buckets": len(games) * 3,
        "good_buckets": sum(
            outcome["quality_status"] == "good"
            for game in conditionals.values()
            for outcome in game["outcomes"].values()
        ),
        "minimum_ess": min(
            outcome["effective_sample_size"]
            for game in conditionals.values()
            for outcome in game["outcomes"].values()
        ) if games else 0.0,
    }
    diagnostics = {
        "effective_config": {
            "runs": runs, "pilot_runs": pilot_runs, "seed": seed, "hfa_points": hfa,
            "margin_sd": margin_sd, "latent_strength_sd": strength_sd,
            "tie_window_points": tie_window, "proposal_shift_points": proposal_shift,
            "proposal_fraction": proposal_fraction, "residual_adaptation_trigger": residual_trigger,
            "min_target_hits": min_target_hits, "min_global_ess": min_global_ess,
            "max_team_mc_se": max_team_mc_se,
            "max_split_half_difference": max_split_half_difference,
            "min_conditional_ess": min_conditional_ess,
            "min_conditional_share": min_conditional_share,
            "max_win_residual": max_win_residual,
            "max_playoff_residual": max_playoff_residual,
        },
        "ordinary_paths": counts[0], "proposal_paths": sum(counts[1:]),
        "proposal_components": [{"team": team, "shift_points": shift, "paths": counts[i + 1]}
                                for i, (team, shift) in enumerate(proposals)],
        "pilot_stage_probabilities": pilot_probs,
        "raw_stage_hits": raw_stage_hits,
        "market_residuals": residuals,
        "max_abs_market_residual": max(abs(row["residual"]) for row in residuals),
        "mean_abs_market_residual": sum(abs(row["residual"]) for row in residuals) / len(residuals),
        "global_ess": ess, "unsupported_positive_targets": unsupported,
        "generated_expected_wins": generated_wins,
        "generated_win_residuals": win_residuals,
        "max_abs_generated_win_residual": max(abs(v) for v in win_residuals.values()),
        "team_payout_mc_se": payout_se, "team_payout_ci95": payout_ci,
        "team_split_half_difference": stability,
        "max_team_payout_mc_se": max_se,
        "max_split_half_difference": max_stability_difference,
        "conditional_quality": conditional_summary,
        "recommended_total_paths_for_payout_precision": math.ceil(
            runs * max(1.0, (max_se / max(max_team_mc_se, 1e-9)) ** 2)
        ),
        "review_ready": (
            not unsupported
            and ess >= min_global_ess
            and max_se <= max_team_mc_se
            and max_stability_difference <= max_split_half_difference
            and max(abs(v) for v in win_residuals.values()) <= max_win_residual
            and max(abs(row["residual"]) for row in residuals) <= max_playoff_residual
        ),
    }
    if return_path_library:
        # Review-only consumers fit weights over these already legal worlds.
        # Keep this behind an explicit flag so the noncanonical engine's
        # historical aggregate-only result remains compact.
        diagnostics["path_library_count"] = len(paths)
    if unsupported:
        return {"status": "failed", "error": "positive playoff outcome remains unsupported after adaptive sampling",
                "diagnostics": diagnostics,
                **({"path_library": _review_path_library(paths, teams)}
                   if return_path_library else {})}
    return {"status": "ok", "runs": runs, "expected_payout": payout,
            "stage_probs": stage_probs, "conditionals": conditionals,
            "diagnostics": diagnostics,
            **({"path_library": _review_path_library(paths, teams)}
               if return_path_library else {})}


def _review_path_library(paths: list[dict[str, Any]],
                         teams: list[str]) -> list[dict[str, Any]]:
    """Convert internal legal worlds to the shared joint-fit path schema."""
    return [
        {
            "id": f"v3-path-{index:08d}",
            "prior_weight": 1.0,
            "wins": {team: float(path["wins"][team]) for team in teams},
            "advancement": {
                team: {
                    stage: int(level >= stage_level)
                    for stage, stage_level in (
                        ("berth", 1), ("divisional", 2), ("conference", 3),
                        ("sb_berth", 4), ("sb_win", 5),
                    )
                }
                for team, level in (
                    (team, max(
                        (4 if path["stage"][team].get("sb_berth") else
                         3 if path["stage"][team].get("conference") else
                         2 if path["stage"][team].get("divisional") else
                         1 if path["stage"][team].get("berth") else 0),
                        5 if path["stage"][team].get("sb_win") else 0,
                    ))
                    for team in teams
                )
            },
            "outcomes": {
                str(game): outcome for game, outcome in enumerate(path["outcomes"])
            },
            "payout": {team: float(path["gross"][team]) for team in teams},
            "legal": True,
        }
        for index, path in enumerate(paths)
    ]