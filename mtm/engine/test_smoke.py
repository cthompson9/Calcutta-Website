"""Smoke tests: run `python test_smoke.py` from scripts/."""
import math
import random

import numpy as np

import playoffs
import run_mtm
import simulate
import valuation
import wins


def _reference_calibrate_weights(weights, hit_indices, targets, anchors,
                                  iterations=20, tolerance=.03):
    """Pre-vectorization tolerance-band calibration reference."""
    weights = list(weights)
    history = []
    keys = list(targets)
    band_margin = min(1e-4, max(1e-6, tolerance * 1e-3))
    for iteration in range(iterations):
        total = sum(weights)
        for key in keys:
            target = targets[key]
            if (target in (0.0, 1.0) or
                    (anchors.get(key[1]) and
                     anchors[key[1]][iteration % len(anchors[key[1]])] == key[0])):
                continue
            lower_band = max(1e-7, target - tolerance + band_margin)
            upper_band = min(1 - 1e-7, target + tolerance - band_margin)
            indices = hit_indices[key]
            hit_weight = sum(weights[i] for i in indices)
            current = hit_weight / total if total else 0.0
            current = min(max(current, 1e-12), 1 - 1e-12)
            if lower_band <= current <= upper_band:
                continue
            projected_target = lower_band if current < lower_band else upper_band
            ratio = ((projected_target / (1 - projected_target))
                     / (current / (1 - current)))
            for i in indices:
                old_weight = weights[i]
                weights[i] = old_weight * ratio
                total += weights[i] - old_weight
        scale = len(weights) / sum(weights)
        weights = [value * scale for value in weights]
        residuals = {
            key: sum(weights[i] for i in hit_indices[key]) / len(weights)
            - targets[key] for key in keys
        }
        history.append(residuals)
        if max(map(abs, residuals.values()), default=0.0) <= tolerance:
            break
    return weights, history


def test_wins_ladder():
    # True distribution: W ~ Binomial(17, 0.6) -> E[W] = 10.2
    p = 0.6
    def surv(k):  # P(W >= k)
        return sum(math.comb(17, i) * p**i * (1-p)**(17-i) for i in range(k, 18))
    rungs = [wins.Rung(k, surv(k) - 0.02, surv(k) + 0.02) for k in range(4, 16)]
    res = wins.expected_wins_from_ladder(rungs)
    assert res["method"] == "ladder_sum", res
    assert abs(res["e_wins"] - 10.2) < 0.15, res["e_wins"]
    # A thin ladder remains an observation; missing strikes are interpolated.
    thin = [wins.Rung(10, 0.48, 0.56)]
    res2 = wins.expected_wins_from_ladder(thin)
    assert res2["method"] == "ladder_sum"
    assert all(res2["curve"][i] >= res2["curve"][i+1] - 1e-9
               for i in range(len(res2["curve"]) - 1))
    # A local inversion is reconciled jointly by weighted isotonic regression.
    messy = [wins.Rung(8, 0.86, 0.88), wins.Rung(9, 0.69, 0.71),
             wins.Rung(10, 0.74, 0.76)]
    res3 = wins.expected_wins_from_ladder(messy)
    c = res3["curve"]
    assert all(c[i] >= c[i+1] - 1e-9 for i in range(len(c)-1)), c
    assert abs(c[9] - .725) < 1e-9 and abs(c[10] - .725) < 1e-9, c

    sea = [wins.Rung(k, bid, ask, status=status, result=result)
           for k, bid, ask, status, result in [
               (1, 0, 1, "finalized", "yes"),
               (2, .99, 1, "active", ""),
               (3, .95, 1, "active", ""),
               (4, .95, 1, "active", ""),
               (5, .94, .97, "active", ""),
               (6, .92, 1, "active", ""),
               (7, .88, .98, "active", ""),
               (8, .82, .92, "active", ""),
               (9, .77, .81, "active", ""),
               (10, .66, .67, "active", ""),
               (11, .53, .55, "active", ""),
               (12, .41, .44, "active", ""),
               (13, .27, .33, "active", ""),
               (14, .18, .21, "active", ""),
               (15, .06, .07, "active", ""),
               (16, 0, .07, "active", ""),
               (17, 0, .03, "active", ""),
           ]]
    sea_result = wins.expected_wins_from_ladder(sea)
    assert sea_result["curve"][1] == 1.0
    assert 10.0 < sea_result["e_wins"] < 11.0, sea_result

    sf = [wins.Rung(r.strike, r.yes_bid, r.yes_ask, r.volume,
                    r.status, r.result) for r in sea]
    sf[10] = wins.Rung(11, .58, .60)
    sf_result = wins.expected_wins_from_ladder(sf)
    assert sf_result["e_wins"] > 10.0, sf_result

    ne = [wins.Rung(k, .5, .5) for k in range(1, 17)]
    ne.append(wins.Rung(17, 0, 1, status="finalized", result="no"))
    ne_result = wins.expected_wins_from_ladder(ne)
    assert ne_result["curve"][17] == 0.0
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
    assert math.isfinite(mc["max_weight"]) and 0 <= mc["max_weight"] <= 1
    assert math.isfinite(mc["effective_sample_size"]) and mc["effective_sample_size"] > 0
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
    assert calibrated["calibration_diagnostics"]["history"]
    assert calibrated["calibration_diagnostics"]["classification"] == "converged"
    assert calibrated["calibration_diagnostics"]["counters"]["iterations"] >= 1
    # The swapped point targets are intentionally not all attained exactly;
    # the contract is the jointly feasible tolerance band.
    assert any(abs(calibrated["calibration_residuals"][f"{t}:{stage}"]) > 1e-6
               for t in teams for stage in valuation.STAGES)
    assert all(abs(residual) <= .03
               for residual in calibrated["calibration_residuals"].values())
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
    runtime = simulate.RuntimeDiagnostics()
    try:
        shifted = run_mtm.build_snapshot(config, shifted_state, runtime=runtime)
        before = {row["team"]: row["expected_payout"]
                  for row in baseline["valuations"]}
        after = {row["team"]: row["expected_payout"]
                 for row in shifted["valuations"]}
        assert abs(after[teams[0]] - before[teams[0]]) > .01
        assert shifted["diagnostics"]["market_calibration"]["status"] == "good"
    except ValueError as error:
        assert "market calibration failed" in str(error)
        details = runtime.snapshot()["details"]["monte_carlo"]
        assert details["calibration"]["classification"] in {
            "plateau", "oscillation", "incomplete"
        }


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
    runtime = simulate.RuntimeDiagnostics()
    try:
        calibrated = simulate.monte_carlo(
            {t: 0.0 for t in teams}, games, realized, divisions, runs=3000,
            seed=9, rubric=rubric, pot=1000, realized_stats=realized,
            stage_targets=targets, calibration_tolerance=.03,
            diagnostics=runtime)
        if calibrated["calibration_converged"]:
            assert all(abs(value) <= .03
                       for value in calibrated["calibration_residuals"].values())
            assert calibrated["stage_probs"][zero_team]["sb_win"] == 0.0
            assert calibrated["stage_probs"][one_team]["berth"] == 1.0
            valued = valuation.value_simulation(
                rubric, [{"entry_id": t, "team": t, "price": 1} for t in teams],
                1000, calibrated, games, min_conditional_samples=1,
                min_conditional_share=0)
            zero_value = next(row for row in valued["entries"]
                              if row["team"] == zero_team)
            assert zero_value["expected_payout"] == 0.0
        else:
            assert calibrated["calibration_diagnostics"]["classification"] in {
                "plateau", "oscillation", "incomplete"
            }
    except ValueError as error:
        assert "playoff target" in str(error) or "calibration" in str(error)
        details = runtime.snapshot()["details"]["monte_carlo"]
        assert details["calibration"]["counters"]["settled_zero_targets"] >= 1
        assert details["calibration"]["counters"]["settled_one_targets"] >= 1


def test_conditional_quality_uses_effective_sample_size():
    team = "A"
    games = [simulate.Game("A", "B", week=1)]
    simulation = {
        "runs": 1000,
        "payout_sum": {"A": 1000000.0},
        "payout_sq_sum": {"A": 1000000000.0},
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


def test_payout_cent_allocation_is_exact_and_deterministic():
    allocated = valuation._allocate_payout_cents(
        {"A": 10 / 3, "B": 10 / 3, "C": 10 / 3},
        10,
    )
    assert allocated == {"A": 3.33, "B": 3.33, "C": 3.34}
    assert round(sum(allocated.values()), 2) == 10


def _longshot_fixture(mathematically_eliminated=False):
    teams = [f"{c}{d}{i}" for c in ["A", "N"] for d in range(4) for i in range(4)]
    divisions = {f"{'AFC' if c == 'A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    longshot = "A00"
    ratings = {t: 0.0 for t in teams}
    schedule = []
    if mathematically_eliminated:
        realized = {t: (0 if t == longshot else 10) for t in teams}
    else:
        realized = {t: 0 for t in teams}
    inventory = {
        "berth": 14, "divisional": 8, "conference": 4,
        "sb_berth": 2, "sb_win": 1,
    }
    targets = {
        t: {stage: total / len(teams) for stage, total in inventory.items()}
        for t in teams
    }
    return teams, divisions, ratings, schedule, realized, targets, longshot


def test_support_strata_recover_feasible_positive_longshot_deterministically():
    teams, divisions, ratings, schedule, realized, targets, longshot = _longshot_fixture()
    try:
        simulate.monte_carlo(
            ratings, schedule, realized, divisions, runs=1, seed=41,
            stage_targets=targets, calibration_tolerance=.03)
        assert False, "ordinary finite sampling should have no longshot support"
    except ValueError as error:
        assert "no simulated support for positive playoff target" in str(error)

    kwargs = dict(
        ratings=ratings, remaining=schedule, realized_wins=realized,
        divisions=divisions, runs=416, seed=41, stage_targets=targets,
        calibration_tolerance=.03, support_runs_per_team=13,
        support_prior_weight=.01)
    first = simulate.monte_carlo(**kwargs)
    second = simulate.monte_carlo(**kwargs)
    assert first["calibration_converged"]
    assert first["calibration_diagnostics"]["classification"] == "converged"
    assert all(abs(value) <= .03
               for value in first["calibration_residuals"].values())
    assert first["stage_probs"] == second["stage_probs"]
    assert first["support_sampling"] == second["support_sampling"]
    assert first["support_sampling"]["enabled"]
    assert any(item.startswith(f"{longshot}:")
               for item in first["support_sampling"]["recovered_targets"])
    assert first["effective_sample_size"] == second["effective_sample_size"]


def test_truly_infeasible_tolerance_band_still_fails():
    """A band cannot manufacture support absent from every simulated path."""
    _, divisions, ratings, schedule, realized, targets, longshot = _longshot_fixture(
        mathematically_eliminated=True)
    try:
        result = simulate.monte_carlo(
            ratings, schedule, realized, divisions, runs=416, seed=41,
            stage_targets=targets, calibration_tolerance=.03,
            support_runs_per_team=13, support_prior_weight=.01)
        assert not result["calibration_converged"]
        assert result["calibration_diagnostics"]["classification"] in {
            "plateau", "oscillation", "incomplete"
        }
    except ValueError as error:
        assert f"{longshot}:berth" in str(error)


def test_chunked_conditional_aggregation_fixed_seed_equivalence():
    """Chunk boundaries must not change the seeded payout contract."""
    first, games, _, realized = _mini_mc(120)
    teams = list(first["stage_probs"])
    targets = {t: dict(first["stage_probs"][t]) for t in teams}
    divisions = {f"{'AFC' if c == 'A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    rubric = {"banked": 150, "per_win": 10, "per_tie": 5, "per_pt_diff": 1,
              "bonuses": {s: 0 for s in valuation.STAGES}}
    kwargs = dict(ratings={t: 0.0 for t in teams}, remaining=games,
                  realized_wins=realized, divisions=divisions, runs=120,
                  seed=9, rubric=rubric, pot=1000, realized_stats=realized,
                  stage_targets=targets)
    one = simulate.monte_carlo(**kwargs, aggregation_chunk_size=1)
    many = simulate.monte_carlo(**kwargs, aggregation_chunk_size=4096)
    assert one["payout_sum"] == many["payout_sum"]
    assert one["payout_sq_sum"] == many["payout_sq_sum"]
    assert one["conditional_payouts"] == many["conditional_payouts"]
    assert one["stage_probs"] == many["stage_probs"]
    assert one["calibration_converged"] == many["calibration_converged"]
    assert one["calibration_residuals"] == many["calibration_residuals"]


def _reference_nested_aggregation(teams, path_outcomes, path_wins,
                                   path_gross, weights, *, chunk_size=4096):
    """Literal pre-optimization reducer used only for equivalence coverage."""
    payout_sum = {t: 0.0 for t in teams}
    payout_sq_sum = {t: 0.0 for t in teams}
    win_sum = {t: 0.0 for t in teams}
    conditional = {
        i: {
            outcome: {
                "count": 0,
                "sum": {t: 0.0 for t in teams},
                "sq": {t: 0.0 for t in teams},
                "weight": 0.0,
                "weight_sq": 0.0,
            }
            for outcome in ("home_win", "away_win", "tie")
        }
        for i in range(len(path_outcomes))
    }
    for path_index, weight in enumerate(weights):
        for team in teams:
            gross = path_gross[team][path_index]
            win_sum[team] += weight * path_wins[team][path_index]
            payout_sum[team] += weight * gross
            payout_sq_sum[team] += weight * gross ** 2
        for game_index, outcomes in enumerate(path_outcomes):
            outcome = ("home_win", "away_win")[outcomes[path_index]]
            bucket = conditional[game_index][outcome]
            bucket["count"] += 1
            bucket["weight"] += weight
            bucket["weight_sq"] += weight * weight
            for team in teams:
                gross = path_gross[team][path_index]
                bucket["sum"][team] += weight * gross
                bucket["sq"][team] += weight * gross ** 2
    return {
        "payout_sum": payout_sum,
        "payout_sq_sum": payout_sq_sum,
        "win_sum": win_sum,
        "conditional_payouts": conditional,
    }


def _assert_complete_float_equivalence(left, right, path=()):
    """Compare complete simulation trees without weakening numeric checks."""
    if isinstance(left, dict):
        assert isinstance(right, dict), path
        assert left.keys() == right.keys(), path
        for key in left:
            _assert_complete_float_equivalence(left[key], right[key],
                                               path + (key,))
    elif isinstance(left, list):
        assert isinstance(right, list) and len(left) == len(right), path
        for index, (left_value, right_value) in enumerate(zip(left, right)):
            _assert_complete_float_equivalence(left_value, right_value,
                                               path + (index,))
    elif isinstance(left, float):
        assert isinstance(right, (int, float)), path
        assert math.isclose(left, right, rel_tol=1e-12, abs_tol=1e-12), (
            path, left, right)
    else:
        assert left == right, (path, left, right)


def test_compact_aggregation_matches_literal_legacy_reference():
    """The compact reducer matches the old nested path-by-path arithmetic."""
    baseline, games, rubric, realized = _mini_mc(120)
    teams = list(baseline["stage_probs"])
    divisions = {
        f"{'AFC' if c == 'A' else 'NFC'} D{d}": [
            f"{c}{d}{i}" for i in range(4)
        ]
        for c in ["A", "N"] for d in range(4)
    }
    targets = {t: dict(baseline["stage_probs"][t]) for t in teams}
    kwargs = dict(
        ratings={t: 0.0 for t in teams}, remaining=games,
        realized_wins=realized, divisions=divisions, runs=120, seed=9,
        rubric=rubric, pot=1000, realized_stats=realized,
        stage_targets=targets, calibration_iters=20,
    )
    compact = simulate.monte_carlo(**kwargs, aggregation_chunk_size=7)
    optimized = simulate._aggregate_path_statistics
    simulate._aggregate_path_statistics = _reference_nested_aggregation
    try:
        legacy = simulate.monte_carlo(**kwargs, aggregation_chunk_size=7)
    finally:
        simulate._aggregate_path_statistics = optimized

    # This covers every team, every game/outcome bucket, and all non-aggregate
    # fields (including stage probabilities and calibration diagnostics).
    _assert_complete_float_equivalence(compact, legacy)


def test_runtime_and_calibration_diagnostics_are_serializable():
    runtime = simulate.RuntimeDiagnostics()
    with runtime.stage("unit"):
        runtime.update_progress("unit", 1, 1)
    runtime.record_detail("example", {"history": [1, 2], "classification": "test"})
    result = _mini_mc(30)[0]
    runtime_snapshot = runtime.snapshot()
    assert runtime_snapshot["stages"]["unit"]["completed"]
    assert runtime_snapshot["details"]["example"]["classification"] == "test"
    assert "calibration_diagnostics" in result
    assert result["calibration_diagnostics"]["classification"] == "not_requested"


def test_runtime_stage_exception_is_recorded_incomplete():
    runtime = simulate.RuntimeDiagnostics()
    try:
        with runtime.stage("raises"):
            raise RuntimeError("synthetic stage failure")
    except RuntimeError:
        pass
    else:
        assert False, "expected synthetic stage failure"
    assert runtime.snapshot()["stages"]["raises"]["completed"] is False


def test_failed_calibration_publishes_runtime_evidence():
    teams, divisions, ratings, schedule, realized, targets, _ = _longshot_fixture()
    runtime = simulate.RuntimeDiagnostics()
    try:
        simulate.monte_carlo(
            ratings, schedule, realized, divisions, runs=1, seed=41,
            stage_targets=targets, calibration_tolerance=.03,
            diagnostics=runtime)
        assert False, "expected an unsupported positive target"
    except ValueError as error:
        assert "no simulated support for positive playoff target" in str(error)
    details = runtime.snapshot()["details"]["monte_carlo"]
    assert details["calibration"]["counters"]["targets_without_support"] > 0
    assert details["support_sampling"]["unresolved_targets"]
    assert details["feasibility"]["simulated_path_count"] == 1


def test_fixed_seed_calibration_respects_inventory():
    base, games, rubric, realized = _mini_mc(1000)
    teams = list(base["stage_probs"])
    divisions = {f"{'AFC' if c == 'A' else 'NFC'} D{d}": [f"{c}{d}{i}" for i in range(4)]
                 for c in ["A", "N"] for d in range(4)}
    targets = {t: dict(base["stage_probs"][t]) for t in teams}
    kwargs = dict(
        ratings={t: 0.0 for t in teams}, remaining=games,
        realized_wins=realized, divisions=divisions, runs=1000, seed=9,
        rubric=rubric, pot=1000, realized_stats=realized,
        stage_targets=targets, calibration_tolerance=.03,
    )
    first = simulate.monte_carlo(**kwargs)
    second = simulate.monte_carlo(**kwargs)
    assert first["calibration_converged"]
    assert first["stage_probs"] == second["stage_probs"]
    assert first["calibration_diagnostics"]["history"] == (
        second["calibration_diagnostics"]["history"])
    assert len(first["calibration_diagnostics"]["history"]) <= 40
    assert first["support_sampling"]["calibration_anchor_policy"] == (
        "rotating_redundant_constraint")
    assert all(abs(residual) <= .03
               for residual in first["calibration_residuals"].values())
    assert first["calibration_diagnostics"]["counters"] == (
        second["calibration_diagnostics"]["counters"])
    inventory = {"berth": 14, "divisional": 8, "conference": 4,
                 "sb_berth": 2, "sb_win": 1}
    for stage, total in inventory.items():
        assert abs(sum(first["stage_probs"][t][stage] for t in teams) - total) < 1e-4


def test_reference_calibration_matches_algebraic_total_update():
    targets = {("A", "berth"): .4, ("B", "berth"): .6}
    hits = {("A", "berth"): [0, 1], ("B", "berth"): [1, 2]}
    anchors = {"berth": []}
    initial = [1.0, 2.0, 1.0]
    reference, reference_history = _reference_calibrate_weights(
        initial, hits, targets, anchors, iterations=8)
    weights = list(initial)
    algebraic_history = []
    tolerance = .03
    band_margin = min(1e-4, max(1e-6, tolerance * 1e-3))
    for _ in range(8):
        total = sum(weights)
        for key, target in targets.items():
            hit_weight = sum(weights[i] for i in hits[key])
            current = min(max(hit_weight / total, 1e-12), 1 - 1e-12)
            lower_band = max(1e-7, target - tolerance + band_margin)
            upper_band = min(1 - 1e-7, target + tolerance - band_margin)
            if lower_band <= current <= upper_band:
                continue
            projected_target = lower_band if current < lower_band else upper_band
            ratio = ((projected_target / (1 - projected_target))
                     / (current / (1 - current)))
            for i in hits[key]:
                old = weights[i]
                weights[i] = old * ratio
                total += weights[i] - old
        total = sum(weights)  # exact legacy normalization denominator
        scale = len(weights) / total
        weights = [value * scale for value in weights]
        algebraic_history.append({
            key: sum(weights[i] for i in hits[key]) / len(weights)
            - targets[key] for key in targets
        })
        if max(map(abs, algebraic_history[-1].values()), default=0.0) <= tolerance:
            break
    assert all(math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)
               for a, b in zip(reference, weights))
    for left, right in zip(reference_history, algebraic_history):
        for key in targets:
            assert math.isclose(left[key], right[key],
                                rel_tol=1e-12, abs_tol=1e-12)


def test_fixed_seed_vectorized_calibration_matches_legacy_reference():
    """Indexed NumPy updates preserve the seeded legacy calibration trace."""
    rng = random.Random(20260829)
    runs = 257
    keys = [(f"T{i}", "berth") for i in range(7)]
    initial = [0.25 + rng.random() for _ in range(runs)]
    hits = {
        key: sorted(rng.sample(range(runs), 70 + index * 9))
        for index, key in enumerate(keys)
    }
    targets = {
        key: 0.18 + (index + 1) * 0.07 for index, key in enumerate(keys)
    }
    anchors = {"berth": ["T0", "T1"]}
    tolerance = .03
    reference, reference_history = _reference_calibrate_weights(
        initial, hits, targets, anchors, iterations=8, tolerance=tolerance,
    )

    weights = np.asarray(initial, dtype=np.float64)
    indices = {key: np.asarray(value, dtype=np.intp)
               for key, value in hits.items()}
    total_weight = float(np.sum(weights, dtype=np.float64))
    vectorized_history = []
    for iteration in range(8):
        for key in keys:
            target = targets[key]
            if anchors[key[1]][iteration % len(anchors[key[1]])] == key[0]:
                continue
            band_margin = min(1e-4, max(1e-6, tolerance * 1e-3))
            lower_band = max(1e-7, target - tolerance + band_margin)
            upper_band = min(1 - 1e-7, target + tolerance - band_margin)
            hit_weight = float(np.sum(weights[indices[key]], dtype=np.float64))
            current = min(max(hit_weight / total_weight, 1e-12), 1 - 1e-12)
            if lower_band <= current <= upper_band:
                continue
            projected_target = lower_band if current < lower_band else upper_band
            ratio = ((projected_target / (1 - projected_target))
                     / (current / (1 - current)))
            total_weight = simulate._apply_calibration_hit_update(
                weights, indices[key], ratio, total_weight)
        scale = len(weights) / float(np.sum(weights, dtype=np.float64))
        weights *= scale
        total_weight = float(len(weights))
        _, residuals = simulate._calibration_residual_vector(
            weights, [indices[key] for key in keys],
            [targets[key] for key in keys],
        )
        vectorized_history.append(dict(zip(keys, residuals)))
        if max(map(abs, residuals), default=0.0) <= tolerance:
            break

    assert np.allclose(weights, reference, rtol=1e-12, atol=1e-12)
    for old_record, new_record in zip(reference_history, vectorized_history):
        for key in keys:
            assert math.isclose(old_record[key], new_record[key],
                                rel_tol=1e-12, abs_tol=1e-12)


def test_fixed_seed_golden_output_from_legacy_engine():
    """Golden values captured before compact/chunked aggregation changes."""
    simulation, games, _, _ = _mini_mc(80)
    # Set iteration order affects which conference is simulated first across
    # processes; the league-wide stage totals are the stable reference.
    expected_totals = {
        "berth": 14.0, "divisional": 8.0, "conference": 4.0,
        "sb_berth": 2.0, "sb_win": 1.0,
    }
    for key, expected in expected_totals.items():
        assert math.isclose(sum(row[key] for row in simulation["stage_probs"].values()),
                            expected, rel_tol=0, abs_tol=1e-12)
    assert math.isclose(simulation["payout_sum"]["A00"],
                        2616.9769751840636, rel_tol=1e-12, abs_tol=1e-9)
    home = simulation["conditional_payouts"][0]["home_win"]
    away = simulation["conditional_payouts"][0]["away_win"]
    assert home["count"] == 42 and away["count"] == 38
    for bucket, expected_sum, expected_sq in [
        (home, 1505.3353892808314, 54053.10785892467),
        (away, 1111.6415859032331, 32597.330581906586),
    ]:
        assert math.isclose(bucket["sum"]["A00"], expected_sum,
                            rel_tol=1e-12, abs_tol=1e-9)
        assert math.isclose(bucket["sq"]["A00"], expected_sq,
                            rel_tol=1e-12, abs_tol=1e-9)


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
    test_payout_cent_allocation_is_exact_and_deterministic()
    test_support_strata_recover_feasible_positive_longshot_deterministically()
    test_truly_infeasible_tolerance_band_still_fails()
    test_chunked_conditional_aggregation_fixed_seed_equivalence()
    test_compact_aggregation_matches_literal_legacy_reference()
    test_runtime_and_calibration_diagnostics_are_serializable()
    test_runtime_stage_exception_is_recorded_incomplete()
    test_failed_calibration_publishes_runtime_evidence()
    test_fixed_seed_calibration_respects_inventory()
    test_reference_calibration_matches_algebraic_total_update()
    test_fixed_seed_vectorized_calibration_matches_legacy_reference()
    test_fixed_seed_golden_output_from_legacy_engine()
    print("\nall smoke tests passed")
