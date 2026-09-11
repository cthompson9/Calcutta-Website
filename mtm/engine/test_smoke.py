"""Smoke tests: run `python test_smoke.py` from scripts/."""
import math
import random

import playoffs
import run_mtm
import simulate
import valuation
import wins


def test_wins_ladder():
    # True distribution: W ~ Binomial(17, 0.6) -> E[W] = 10.2
    p = 0.6
    def surv(k):  # P(W >= k)
        return sum(math.comb(17, i) * p**i * (1-p)**(17-i) for i in range(k, 18))
    rungs = [wins.Rung(k, surv(k) - 0.02, surv(k) + 0.02) for k in range(4, 16)]
    res = wins.expected_wins_from_ladder(rungs)
    assert res["method"] == "ladder_sum", res
    assert abs(res["e_wins"] - 10.2) < 0.15, res["e_wins"]
    # thin ladder falls back
    thin = [wins.Rung(10, 0.48, 0.56)]
    res2 = wins.expected_wins_from_ladder(thin)
    assert res2["method"] == "single_rung_fallback"
    assert abs(res2["e_wins"] - (9 + 0.52)) < 1e-6
    # monotonicity violation gets clamped, not propagated
    messy = [wins.Rung(8, 0.70, 0.74), wins.Rung(9, 0.80, 0.84),  # violates
             wins.Rung(10, 0.40, 0.44), wins.Rung(11, 0.20, 0.24),
             wins.Rung(12, 0.10, 0.12)]
    res3 = wins.expected_wins_from_ladder(messy)
    c = res3["curve"]
    assert all(c[i] >= c[i+1] - 1e-9 for i in range(len(c)-1)), c
    print(f"wins ok: binomial E[W]={res['e_wins']} (true 10.2), fallback={res2['e_wins']}")


def test_playoff_normalization():
    rng = random.Random(7)
    teams = [f"T{i}" for i in range(32)]
    # fake raw reach probs with longshot-biased inflation, sums off target
    reach = {}
    for i, t in enumerate(teams):
        strength = (32 - i) / 32
        berth = min(0.97, 0.15 + 0.8 * strength + rng.uniform(0, 0.05))
        reach[t] = {
            "berth": berth,
            "divisional": berth * (0.4 + 0.4 * strength),
            "conference": berth * (0.2 + 0.3 * strength),
            "sb_berth": berth * (0.1 + 0.2 * strength),
            "sb_win": berth * (0.05 + 0.12 * strength),
        }
    targets = {"berth": 14, "divisional": 8, "conference": 4, "sb_berth": 2, "sb_win": 1}
    raw_sums = {s: sum(reach[t][s] for t in teams) for s in targets}
    out = playoffs.normalize_all(reach, targets)
    for s, tgt in targets.items():
        total = sum(out["probs"][t][s] for t in teams)
        assert abs(total - tgt) < 0.05, (s, total)
    for t in teams:
        pr = out["probs"][t]
        seq = [pr[s] for s in playoffs.STAGES]
        assert all(a >= b - 1e-9 for a, b in zip(seq, seq[1:])), (t, seq)
    # settled team stays settled
    reach["T0"] = {"berth": 1.0, "divisional": 1.0, "conference": 0.55,
                   "sb_berth": 0.3, "sb_win": 0.18}
    out2 = playoffs.normalize_all(reach, targets)
    assert out2["probs"]["T0"]["berth"] == 1.0
    print(f"playoffs ok: raw sums {dict((k, round(v,1)) for k,v in raw_sums.items())} "
          f"-> residuals {out['residuals']}, alphas {out['alphas']}")


def test_ratings_fit_and_diff():
    rng = random.Random(3)
    teams = [f"T{i}" for i in range(8)]
    true_r = {t: rng.gauss(0, 5) for t in teams}
    mean = sum(true_r.values()) / len(true_r)
    true_r = {t: v - mean for t, v in true_r.items()}
    # round robin twice, some marquee
    sched = []
    for i, a in enumerate(teams):
        for b in teams[i+1:]:
            sched.append(simulate.Game(a, b, marquee=rng.random() < 0.2))
            sched.append(simulate.Game(b, a, marquee=rng.random() < 0.2))
    # target wins = analytic wins under true ratings
    def implied(r):
        w = {t: 0.0 for t in teams}
        for g in sched:
            ph = 0.5 * (1 + math.erf((r[g.home] - r[g.away] + 1.6) / 13.5 / math.sqrt(2)))
            w[g.home] += ph
            w[g.away] += 1 - ph
        return w
    target = implied(true_r)
    fit = simulate.fit_ratings(target, sched)
    err = max(abs(fit["ratings"][t] - true_r[t]) for t in teams)
    assert err < 0.25, (err, fit["max_abs_win_error"])
    diffs = simulate.expected_remaining_diff(fit["ratings"], sched)
    assert abs(sum(d["raw"] for d in diffs.values())) < 0.5           # zero-sum
    assert abs(sum(d["marquee_addon"] for d in diffs.values())) < 0.5  # zero-sum
    print(f"ratings ok: recovered within {err:.3f} pts, win-fit err "
          f"{fit['max_abs_win_error']}, diff zero-sum holds")


def test_valuation_identity():
    rubric = {"banked": 150, "per_win": 10, "per_tie": 5, "per_pt_diff": 1,
              "denominator": 11420,
              "bonuses": {"berth": 50, "divisional": 100, "conference": 200,
                          "sb_berth": 400, "sb_win": 800}}
    # a fully-resolved champion season for one team must price exactly
    realized = {"wins": 14, "ties": 0, "adj_pt_diff": 120}
    proj = {"e_remaining_wins": 0.0, "e_remaining_ties": 0.0,
            "e_remaining_raw_diff": 0.0, "e_remaining_marquee_addon": 0.0,
            "p_stage": {"berth": 1, "divisional": 1, "conference": 1,
                        "sb_berth": 1, "sb_win": 1}}
    v = valuation.value_team(rubric, realized, proj)
    expect = 150 + 140 + 120 + 1550
    assert v["expected_points"] == expect, v
    print(f"valuation ok: resolved champion = {v['expected_points']} pts "
          f"(share {v['expected_share']:.4f})")


def test_monte_carlo_runs():
    teams = [f"{c}{d}{i}" for c in ["A", "N"] for d in range(4) for i in range(4)]
    divisions = {f"{'AFC' if c=='A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    rng = random.Random(1)
    ratings = {t: rng.gauss(0, 5) for t in teams}
    realized = {t: rng.randint(2, 8) for t in teams}
    sched = []
    for _ in range(60):
        a, b = rng.sample(teams, 2)
        sched.append(simulate.Game(a, b, marquee=rng.random() < 0.25))
    mc = simulate.monte_carlo(ratings, sched, realized, divisions, runs=2000)
    sums = {s: sum(mc["stage_probs"][t][s] for t in teams)
            for s in ["berth", "divisional", "conference", "sb_berth", "sb_win"]}
    assert abs(sums["berth"] - 14) < 0.01 and abs(sums["sb_win"] - 1) < 0.01, sums
    print(f"monte carlo ok: stage sums {dict((k, round(v,2)) for k,v in sums.items())}")


def _mini_mc(runs=80):
    teams = [f"{c}{d}{i}" for c in ["A", "N"] for d in range(4) for i in range(4)]
    divisions = {f"{'AFC' if c=='A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    games = [simulate.Game(teams[0], teams[1], week=1)]
    ratings = {t: 0.0 for t in teams}
    realized = {t: {"wins": 0, "ties": 0, "adj_pt_diff": 0} for t in teams}
    rubric = {"banked": 150, "per_win": 10, "per_tie": 5, "per_pt_diff": 1,
              "bonuses": {s: 0 for s in valuation.STAGES}}
    return simulate.monte_carlo(ratings, games, realized, divisions, runs=runs,
                                seed=9, rubric=rubric, pot=1000,
                                realized_stats=realized), games, rubric, realized


def test_deterministic_replay_and_path_conservation():
    a, games, rubric, _ = _mini_mc()
    b, _, _, _ = _mini_mc()
    assert a["payout_sum"] == b["payout_sum"]
    assert abs(sum(a["payout_sum"].values()) / a["runs"] - 1000) < 1e-6
    out = valuation.value_simulation(rubric,
        [{"entry_id": "x", "team": "A00", "price": 1}], 1000, a, games,
        min_conditional_samples=1, min_conditional_share=0)
    assert abs(out["diagnostics"]["conservation_residual"]) < 1e-6


def test_week_zero_and_conditional_reconciliation():
    mc, games, rubric, realized = _mini_mc(200)
    assert all(v["wins"] == 0 and v["ties"] == 0 for v in realized.values())
    out = valuation.value_simulation(rubric,
        [{"entry_id": "x", "team": "A00", "price": 1}], 1000, mc, games,
        min_conditional_samples=1, min_conditional_share=0)
    buckets = out["conditional_payouts"]["0"]["outcomes"]
    residuals = {buckets[o]["A00"]["reconciliation_residual"] for o in buckets}
    assert max(abs(x) for x in residuals) < 1e-6


def test_tie_bucket_is_insufficient_not_zero():
    mc, games, rubric, _ = _mini_mc(30)
    out = valuation.value_simulation(rubric,
        [{"entry_id": "x", "team": "A00", "price": 1}], 1000, mc, games,
        min_conditional_samples=2, min_conditional_share=.1)
    tie = out["conditional_payouts"]["0"]["outcomes"]["tie"]["A00"]
    assert tie["sample_count"] == 0
    assert tie["quality_status"] == "insufficient"
    assert tie["gross_expected_payout"] is None


def test_playoff_market_targets_change_authoritative_values():
    base, games, _, realized = _mini_mc(3000)
    teams = list(base["stage_probs"])
    divisions = {f"{'AFC' if c=='A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    targets = {t: dict(base["stage_probs"][t]) for t in teams}
    first, second = teams[0], teams[1]
    targets[first], targets[second] = targets[second], targets[first]
    rubric = {"banked": 150, "per_win": 10, "per_tie": 5, "per_pt_diff": 1,
              "bonuses": {"berth": 50, "divisional": 100, "conference": 200,
                          "sb_berth": 400, "sb_win": 800}}
    entries = [{"entry_id": t, "team": t, "price": 1} for t in teams]
    calibrated = simulate.monte_carlo(
        {t: 0.0 for t in teams}, games, realized, divisions, runs=3000,
        seed=9, rubric=rubric, pot=1000, realized_stats=realized,
        stage_targets=targets, calibration_tolerance=.03)
    assert calibrated["calibration_converged"]
    for t in teams:
        for stage in valuation.STAGES:
            assert abs(calibrated["stage_probs"][t][stage] - targets[t][stage]) <= .03
    valued = valuation.value_simulation(rubric, entries, 1000, calibrated, games,
                                        min_conditional_samples=1,
                                        min_conditional_share=0)
    original = valuation.value_simulation(rubric, entries, 1000, base, games,
                                          min_conditional_samples=1,
                                          min_conditional_share=0)
    old = {row["team"]: row["expected_payout"] for row in original["entries"]}
    new = {row["team"]: row["expected_payout"] for row in valued["entries"]}
    assert abs(new[first] - old[first]) > .01 or abs(new[second] - old[second]) > .01


def test_elimination_quotes_change_official_snapshot_valuation():
    teams = [f"{c}{d}{i}" for c in ["A", "N"] for d in range(4) for i in range(4)]
    divisions = {f"{'AFC' if c == 'A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    config = {
        "season": 2026,
        "games_per_team": 17,
        "rubric": {
            "banked": 150, "per_win": 10, "per_tie": 5, "per_pt_diff": 1,
            "denominator": 11420,
            "bonuses": {"berth": 50, "divisional": 100, "conference": 200,
                        "sb_berth": 400, "sb_win": 800},
        },
        "stage_targets": {"comment": "production configs may include explanatory metadata",
                          "berth": 14, "divisional": 8, "conference": 4,
                          "sb_berth": 2, "sb_win": 1},
        "pricing": {"max_spread_for_mid": .15},
        "sim": {"hfa_points": 1.6, "margin_sd": 13.5, "rating_fit_lr": .5,
                "rating_fit_iters": 20, "monte_carlo_runs": 3000, "seed": 19,
                "calibration_tolerance": .03, "calibration_iters": 500,
                "min_conditional_samples": 1, "min_conditional_share": 0},
    }
    neutral = {"no_playoffs": .50, "wild_card": .20, "divisional": .12,
               "conference": .08, "sb_loss": .05, "sb_win": .03}
    state = {
        "pot": 1000,
        "entries": [{"entry_id": t, "team": t, "price": 1} for t in teams],
        "realized": {t: {"wins": 0, "ties": 0, "adj_pt_diff": 0} for t in teams},
        "remaining_schedule": [],
        "divisions": divisions,
        "win_ladders": {t: [{"strike": 1, "yes_bid": 0, "yes_ask": 0}] for t in teams},
        "elimination_quotes": {t: dict(neutral) for t in teams},
    }
    baseline = run_mtm.build_snapshot(config, state)
    shifted_state = {**state, "elimination_quotes": {
        **state["elimination_quotes"],
        teams[0]: {"no_playoffs": .30, "wild_card": .20, "divisional": .16,
                   "conference": .12, "sb_loss": .12, "sb_win": .10},
        teams[1]: {"no_playoffs": .65, "wild_card": .15, "divisional": .09,
                   "conference": .06, "sb_loss": .03, "sb_win": .02},
    }}
    shifted = run_mtm.build_snapshot(config, shifted_state)
    before = {row["team"]: row["expected_payout"] for row in baseline["valuations"]}
    after = {row["team"]: row["expected_payout"] for row in shifted["valuations"]}
    assert abs(after[teams[0]] - before[teams[0]]) > .01
    assert shifted["diagnostics"]["market_calibration"]["status"] == "good"


def test_zero_settled_target_needs_no_simulated_support():
    base, games, rubric, realized = _mini_mc(1)
    teams = list(base["stage_probs"])
    divisions = {f"{'AFC' if c == 'A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    targets = {t: dict(base["stage_probs"][t]) for t in teams}
    assert any(targets[t]["sb_win"] == 0 for t in teams)
    calibrated = simulate.monte_carlo(
        {t: 0.0 for t in teams}, games, realized, divisions, runs=1,
        seed=9, rubric=rubric, pot=1000, realized_stats=realized,
        stage_targets=targets, calibration_tolerance=.03)
    assert calibrated["calibration_converged"]


def test_settled_targets_remove_impossible_weighted_paths():
    base, games, _, realized = _mini_mc(3000)
    teams = list(base["stage_probs"])
    divisions = {f"{'AFC' if c == 'A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    targets = {t: dict(base["stage_probs"][t]) for t in teams}
    zero_team = next(t for t in teams if targets[t]["sb_win"] > 0)
    removed = targets[zero_team]["sb_win"]
    targets[zero_team]["sb_win"] = 0.0
    recipients = [t for t in teams if t != zero_team]
    recipient_total = sum(targets[t]["sb_win"] for t in recipients)
    for t in recipients:
        targets[t]["sb_win"] += removed * targets[t]["sb_win"] / recipient_total

    one_team = next(t for t in teams if 0 < targets[t]["berth"] < 1)
    old_berth = targets[one_team]["berth"]
    targets[one_team]["berth"] = 1.0
    others = [t for t in teams if t != one_team]
    other_total = sum(targets[t]["berth"] for t in others)
    for t in others:
        targets[t]["berth"] *= (other_total - (1.0 - old_berth)) / other_total

    rubric = {"banked": 0, "per_win": 0, "per_tie": 0, "per_pt_diff": 0,
              "bonuses": {"berth": 0, "divisional": 0, "conference": 0,
                          "sb_berth": 0, "sb_win": 1}}
    calibrated = simulate.monte_carlo(
        {t: 0.0 for t in teams}, games, realized, divisions, runs=3000,
        seed=9, rubric=rubric, pot=1000, realized_stats=realized,
        stage_targets=targets, calibration_tolerance=.03)
    assert calibrated["calibration_converged"]
    assert calibrated["stage_probs"][zero_team]["sb_win"] == 0.0
    assert calibrated["stage_probs"][one_team]["berth"] == 1.0
    valued = valuation.value_simulation(
        rubric, [{"entry_id": t, "team": t, "price": 1} for t in teams],
        1000, calibrated, games, min_conditional_samples=1,
        min_conditional_share=0)
    zero_value = next(row for row in valued["entries"] if row["team"] == zero_team)
    assert zero_value["expected_payout"] == 0.0


def test_conditional_quality_uses_effective_sample_size():
    team = "A"
    games = [simulate.Game("A", "B", week=1)]
    simulation = {
        "runs": 1000,
        "payout_sum": {"A": 500000.0},
        "payout_sq_sum": {"A": 250000000.0},
        "conditional_payouts": {
            0: {
                "home_win": {
                    "count": 1000, "weight": 1000.0, "weight_sq": 1000000.0,
                    "sum": {"A": 500000.0}, "sq": {"A": 250000000.0},
                },
                "away_win": {
                    "count": 0, "weight": 0.0, "weight_sq": 0.0,
                    "sum": {"A": 0.0}, "sq": {"A": 0.0},
                },
                "tie": {
                    "count": 0, "weight": 0.0, "weight_sq": 0.0,
                    "sum": {"A": 0.0}, "sq": {"A": 0.0},
                },
            }
        },
    }
    rubric = {"banked": 0, "per_win": 0, "per_tie": 0, "per_pt_diff": 0,
              "bonuses": {s: 0 for s in valuation.STAGES}}
    out = valuation.value_simulation(
        rubric, [{"entry_id": team, "team": team, "price": 1}],
        1000, simulation, games, min_conditional_samples=100,
        min_conditional_share=.01)
    bucket = out["conditional_payouts"]["0"]["outcomes"]["home_win"][team]
    assert bucket["sample_count"] == 1000
    assert bucket["sample_share"] == 1.0
    assert bucket["effective_sample_size"] == 1.0
    assert bucket["quality_status"] == "insufficient"


if __name__ == "__main__":
    test_wins_ladder()
    test_playoff_normalization()
    test_ratings_fit_and_diff()
    test_valuation_identity()
    test_monte_carlo_runs()
    test_deterministic_replay_and_path_conservation()
    test_week_zero_and_conditional_reconciliation()
    test_tie_bucket_is_insufficient_not_zero()
    test_playoff_market_targets_change_authoritative_values()
    test_elimination_quotes_change_official_snapshot_valuation()
    test_zero_settled_target_needs_no_simulated_support()
    test_settled_targets_remove_impossible_weighted_paths()
    test_conditional_quality_uses_effective_sample_size()
    print("\nall 13 smoke tests passed")
