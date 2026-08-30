"""Market-calibrated season engine.

Core idea: team ratings are NOT maintained state. Every run re-fits a point-
scale rating vector r (mean 0) so that the analytic expected remaining wins
implied by r over the remaining schedule matches the market's E[remaining wins]
(= ladder E[W] minus realized wins). Because ratings are in POINTS:

    E[margin of i over j at i's home] = r_i - r_j + HFA
    P(i wins)                        = Phi((r_i - r_j + HFA) / margin_sd)

so the same fit prices both future win probability and future point
differential, and the whole thing re-syncs to reality (games played, injuries,
trades) automatically each pull because the market already has.

Outputs per team:
  - e_remaining_pt_diff (raw)  and e_remaining_marquee_diff (the 2x add-on)
  - optional Monte Carlo playoff-stage probabilities (CROSS-CHECK ONLY;
    the elimination markets are the primary source)

For rank-based rubrics (e.g. NFL 2024's ranked-differential ladder) use
monte_carlo(...)['diff_samples'] - expectations are not enough there.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass


def _phi(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


@dataclass
class Game:
    home: str
    away: str
    marquee: bool = False   # outside Sun 1-7pm ET window; diff counts double
    week: int = 0


def fit_ratings(target_remaining_wins: dict[str, float],
                remaining: list[Game],
                hfa: float = 1.6,
                margin_sd: float = 13.5,
                lr: float = 0.5,
                iters: int = 200) -> dict:
    """Solve r so implied remaining wins match market. Returns ratings + fit error.

    Gradient-free fixed point: nudge each rating by (target - implied) * lr *
    (points per win locally ~ margin_sd / density). Converges fast for NFL-size
    problems; ties contribute 0.5 win-equivalents implicitly via Phi symmetry.
    """
    teams = list(target_remaining_wins.keys())
    r = {t: 0.0 for t in teams}
    games_by_team: dict[str, int] = {t: 0 for t in teams}
    for g in remaining:
        games_by_team[g.home] += 1
        games_by_team[g.away] += 1

    def implied() -> dict[str, float]:
        w = {t: 0.0 for t in teams}
        for g in remaining:
            p_home = _phi((r[g.home] - r[g.away] + hfa) / margin_sd)
            w[g.home] += p_home
            w[g.away] += 1.0 - p_home
        return w

    err = float("inf")
    for _ in range(iters):
        w = implied()
        err = max(abs(w[t] - target_remaining_wins[t]) for t in teams) if teams else 0.0
        if err < 1e-4:
            break
        for t in teams:
            n = max(games_by_team[t], 1)
            # d(wins)/d(rating) ~= n * pdf(0)/sd ~= n * 0.4 / sd  -> invert
            step = (target_remaining_wins[t] - w[t]) * lr * (margin_sd / (0.4 * n))
            r[t] += step
        mean = sum(r.values()) / len(r)
        r = {t: v - mean for t, v in r.items()}
    return {"ratings": {t: round(v, 3) for t, v in r.items()},
            "max_abs_win_error": round(err, 4)}


def expected_remaining_diff(ratings: dict[str, float],
                            remaining: list[Game],
                            hfa: float = 1.6) -> dict[str, dict[str, float]]:
    """Analytic E[remaining raw diff] and E[marquee add-on] per team.
    Adjusted diff for the rubric = raw + marquee_addon (the 2x means the
    marquee margin is counted once more on top of raw). Both are zero-sum
    league-wide, preserving the fixed denominator."""
    out = {t: {"raw": 0.0, "marquee_addon": 0.0} for t in ratings}
    for g in remaining:
        m = ratings[g.home] - ratings[g.away] + hfa   # E[home margin]
        out[g.home]["raw"] += m
        out[g.away]["raw"] -= m
        if g.marquee:
            out[g.home]["marquee_addon"] += m
            out[g.away]["marquee_addon"] -= m
    return {t: {k: round(v, 2) for k, v in d.items()} for t, d in out.items()}


def monte_carlo(ratings: dict[str, float],
                remaining: list[Game],
                realized_wins: dict[str, float],
                divisions: dict[str, list[str]],
                hfa: float = 1.6,
                margin_sd: float = 13.5,
                runs: int = 20000,
                seed: int = 20260829) -> dict:
    """Cross-check simulator. Simplified seeding: division winners by wins
    (random tiebreak), wildcards by wins. Playoff games decided by Phi on
    neutral-adjusted ratings (home field to better seed until SB, SB neutral).
    Deliberately NOT the primary playoff source - the elimination markets are.
    Also returns per-team season diff samples for rank-based rubrics.
    """
    rng = random.Random(seed)
    teams = list(ratings.keys())
    stage_hits = {t: {"berth": 0, "divisional": 0, "conference": 0,
                      "sb_berth": 0, "sb_win": 0} for t in teams}
    diff_samples: dict[str, list[float]] = {t: [] for t in teams}

    conf_of = {}
    for conf, divs in divisions.items():
        pass  # divisions arg shape: {"AFC East": [...], ...}; conf from name prefix
    for div, ts in divisions.items():
        conf = div.split()[0]
        for t in ts:
            conf_of[t] = conf

    def play(a: str, b: str, home: str | None) -> tuple[str, float]:
        adv = hfa if home == a else (-hfa if home == b else 0.0)
        mean = ratings[a] - ratings[b] + adv
        margin = rng.gauss(mean, margin_sd)
        return (a, margin) if margin >= 0 else (b, -margin)

    for _ in range(runs):
        wins = dict(realized_wins)
        diff = {t: 0.0 for t in teams}
        for g in remaining:
            winner, margin = play(g.home, g.away, g.home)
            wins[winner] = wins.get(winner, 0) + 1
            sgn = 1 if winner == g.home else -1
            diff[g.home] += sgn * margin
            diff[g.away] -= sgn * margin
        for t in teams:
            diff_samples[t].append(diff[t])

        # seeding per conference
        for conf in {c for c in conf_of.values()}:
            div_winners = []
            for div, ts in divisions.items():
                if not div.startswith(conf):
                    continue
                best = max(ts, key=lambda t: (wins.get(t, 0), rng.random()))
                div_winners.append(best)
            others = [t for t in teams if conf_of[t] == conf and t not in div_winners]
            wildcards = sorted(others, key=lambda t: (wins.get(t, 0), rng.random()),
                               reverse=True)[:3]
            div_winners.sort(key=lambda t: (wins.get(t, 0), rng.random()), reverse=True)
            seeds = div_winners + wildcards          # 1..7
            for t in seeds:
                stage_hits[t]["berth"] += 1
            # wild card round: 2v7 3v6 4v5, 1 bye
            wc_winners = [seeds[0]]
            for hi, lo in [(1, 6), (2, 5), (3, 4)]:
                w, _ = play(seeds[hi], seeds[lo], seeds[hi])
                wc_winners.append(w)
            for t in wc_winners:
                stage_hits[t]["divisional"] += 1
            wc_winners.sort(key=lambda t: seeds.index(t))
            w1, _ = play(wc_winners[0], wc_winners[3], wc_winners[0])
            w2, _ = play(wc_winners[1], wc_winners[2], wc_winners[1])
            finalists = sorted([w1, w2], key=lambda t: seeds.index(t))
            for t in finalists:
                stage_hits[t]["conference"] += 1
            cw, _ = play(finalists[0], finalists[1], finalists[0])
            stage_hits[cw]["sb_berth"] += 1
            if conf == sorted({c for c in conf_of.values()})[0]:
                sb_a = cw
            else:
                sb_b = cw
        sb_winner, _ = play(sb_a, sb_b, None)
        stage_hits[sb_winner]["sb_win"] += 1

    probs = {t: {s: round(h / runs, 4) for s, h in d.items()}
             for t, d in stage_hits.items()}
    return {"stage_probs": probs, "diff_samples": diff_samples, "runs": runs}
