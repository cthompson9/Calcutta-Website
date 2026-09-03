"""Smoke tests: run `python test_smoke.py` from scripts/."""
import math
import random

import playoffs
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


if __name__ == "__main__":
    test_wins_ladder()
    test_playoff_normalization()
    test_ratings_fit_and_diff()
    test_valuation_identity()
    test_monte_carlo_runs()
    print("\nall smoke tests passed")
