"""Private, offline reconstruction. No provider/DB calls; never publishes."""
import hashlib
import json
import os
import pathlib
import sys
import time

import numpy as np

import argparse

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bundle',required=True,type=pathlib.Path,help='Private extracted replay directory')
parser.add_argument('--output',required=True,type=pathlib.Path,help='Private output directory; keep out of Git')
parser.add_argument('--config',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[1]/'season-config-2026.json')
parser.add_argument('--stage',type=int,choices=[4,5],default=4)
ARGS=parser.parse_args()
ENGINE=pathlib.Path(__file__).resolve().parent
import simulate
import simulate as review
import wins
import playoffs
from schedule_feasible_fit import fit_schedule_feasible_candidate
from importance_sampling_review import MarginMixtureProposal


def peak_memory_bytes():
    if os.name != 'nt':
        import resource
        value=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value if sys.platform=='darwin' else value*1024)
    import ctypes
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in
            ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage',
             'QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
    data=Counters(); data.cb=ctypes.sizeof(data)
    process=ctypes.windll.kernel32.GetCurrentProcess
    process.restype=wintypes.HANDLE
    query=ctypes.windll.psapi.GetProcessMemoryInfo
    query.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
    query.restype=wintypes.BOOL
    ok=query(process(),ctypes.byref(data),data.cb)
    return int(data.PeakWorkingSetSize) if ok else None


def read(name):
    return json.loads((ARGS.bundle / name).read_text())


def main():
    assert os.environ.get('PYTHONHASHSEED') == '0', 'Pin hash seed for conference set iteration'
    manifest = read('manifest.json')
    for name, meta in manifest['sections'].items():
        assert hashlib.sha256((ARGS.bundle / name).read_bytes()).hexdigest() == meta['sha256']
    state = read('model-state.json')
    cfg = json.loads(ARGS.config.read_text())
    sc = cfg['sim']
    remaining = [review.Game(**g) for g in state['remaining_schedule']]
    targets = {}
    for team, ladder in state['win_ladders'].items():
        result = wins.expected_wins_from_ladder(
            [wins.Rung(r['strike'], r.get('yes_bid'), r.get('yes_ask'),
                       r.get('volume', 0), r.get('status'), r.get('result')) for r in ladder],
            cfg['games_per_team'], cfg['pricing']['max_spread_for_mid'])
        targets[team] = max(result['e_wins'] - state['realized'][team]['wins'], 0)
    stage_targets = playoffs.normalize_all(
        {t: playoffs.reach_from_elimination(q) for t, q in state['elimination_quotes'].items()},
        cfg['stage_targets'])['probs']
    fit_start = time.perf_counter()
    legacy = simulate.fit_ratings(targets, remaining, hfa=sc['hfa_points'],
        margin_sd=sc['margin_sd'], lr=sc['rating_fit_lr'], iters=sc['rating_fit_iters'])
    legacy_seconds = time.perf_counter() - fit_start
    fit_start = time.perf_counter()
    candidate = fit_schedule_feasible_candidate(targets,
        [{k:g[k] for k in ('home','away','week','event_id') if k in g} for g in state['remaining_schedule']],
        hfa=sc['hfa_points'], margin_sd=sc['margin_sd'])
    candidate_seconds = time.perf_counter() - fit_start
    outdir = ARGS.output
    outdir.mkdir(parents=True,exist_ok=True)
    (outdir/'candidate-fit.json').write_text(json.dumps(candidate, indent=2))
    assumptions = {
        'scope':'reconstructed offline replay, not exact failed execution',
        'source_base_revision':'3ac29437a046f524ed89cf9db06fb49765aff717 plus offline review patch',
        'source_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [ENGINE/'simulate.py',ENGINE/'schedule_feasible_fit.py',ENGINE/'importance_sampling_review.py',pathlib.Path(__file__)]},
        'candidate_revision':'3ac29437a046f524ed89cf9db06fb49765aff717',
        'missing_original_fields':manifest['missing_original_fields'],
        'configuration_source':'baseline season-config-2026.json; not proven original effective config',
        'pot':100.0, 'pot_note':'synthetic 100-unit pool, no owner or dollar comparison',
        'python_hash_seed':0, 'path_count':sc['monte_carlo_runs'],
        'confidence':'explicit equal weights; saved state lacks Stage 1 accepted confidence',
        'raw_target_total':sum(targets.values()), 'remaining_games':len(remaining),
        'sim_config':sc, 'fit_seconds':{'legacy':legacy_seconds,'candidate':candidate_seconds},
    }
    (outdir/f'stage{ARGS.stage}-assumptions.json').write_text(json.dumps(assumptions,indent=2))
    print(json.dumps({'targets':sum(targets.values()),'games':len(remaining),
        'legacy_fit_error':legacy['max_abs_win_error'], 'candidate':candidate['fit'],
        'termination':candidate['termination']}), flush=True)
    # Fixed seeds declared in advance. No seed selection based on results.
    stage5 = ARGS.stage == 5
    seeds = [20260901,20260902,20260903] if stage5 else [sc['seed'], sc['seed'] + 1, sc['seed'] + 2]
    if stage5:
        pilot=json.loads((outdir/'candidate-20260829.json').read_text())
        scores={}
        for key,row in pilot['support']['target_support'].items():
            team=key.split(':')[0]
            score=row['target']/max(row['ordinary_path_count']/39200,1/39200)
            scores[team]=max(scores.get(team,0),score)
        proposal_teams=sorted(scores,key=lambda t:(-scores[t],t))[:8]
        (outdir/'stage5-design.json').write_text(json.dumps({
            'pilot':'candidate-20260829','selection':'top eight max(target / max(ordinary_frequency, 1/39200))',
            'teams':proposal_teams,'validation_seeds':seeds,'runs_per_batch':40000,
            'base_fraction':.5,'regular_shift':6,'playoff_shift':10,
            'maximum_batches':3,'expected_wall_seconds_per_batch':180,
            'stop':'no production activation; do not grow sample budget if three batches fail the existing gates',
            'no_seed_selection':True},indent=2))
    for seed in seeds:
        variants = [('ordinary',candidate),('mixture',candidate)] if stage5 else [('legacy',legacy),('candidate',candidate)]
        for name, fitted in variants:
            started = time.perf_counter()
            # Use identical team order as well as identical random stream.
            ratings = {t:fitted['ratings'][t] for t in targets}
            try:
                result = review.monte_carlo(ratings, remaining,
                {t:state['realized'][t]['wins'] for t in targets}, state['divisions'],
                hfa=sc['hfa_points'], margin_sd=sc['margin_sd'], runs=sc['monte_carlo_runs'],
                seed=seed, rubric=cfg['rubric'], pot=100.0, realized_stats=state['realized'],
                stage_targets=stage_targets, calibration_tolerance=sc['calibration_tolerance'],
                calibration_iters=sc['calibration_iters'], support_runs_per_team=0 if stage5 else sc['support_runs_per_team'],
                support_prior_weight=sc['support_prior_weight'],
                    review_proposal=MarginMixtureProposal(proposal_teams) if name=='mixture' else None,
                    return_review_arrays=True)
            except ValueError as error:
                failure={'solver':name,'seed':seed,'status':'failed', 'error':str(error),
                         'seconds':time.perf_counter()-started}
                (outdir/f'{name}-{seed}.json').write_text(json.dumps(failure,indent=2))
                print(json.dumps(failure),flush=True)
                continue
            arrays = result.pop('_review_arrays')
            w = np.asarray(arrays['weights'])
            gross = np.column_stack([arrays['gross'][t] for t in targets])
            means = w @ gross
            # Fixed-weight SNIS linearization only; refitted-calibration variability
            # additionally assessed across the three independent simulation batches.
            se = np.sqrt(np.sum(w[:,None]**2 * (gross-means)**2,axis=0))
            win_counts = {t:sum(g.home==t or g.away==t for g in remaining) for t in targets}
            implied = simulate.implied_total_wins(ratings, remaining,
                {t:state['realized'][t]['wins'] for t in targets},hfa=sc['hfa_points'],margin_sd=sc['margin_sd'])
            prefit = {t:(implied[t]-state['realized'][t]['wins']-targets[t])/win_counts[t] for t in targets}
            posterior = {t:(float(w @ np.asarray(arrays['wins'][t]))-state['realized'][t]['wins']-targets[t])/win_counts[t] for t in targets}
            summary = {
                'solver':name,'seed':seed,'runs':len(w),'seconds':time.perf_counter()-started,
                'peak_process_memory_bytes':peak_memory_bytes(),
                'ess':result['effective_sample_size'],'max_weight':result['max_weight'],
                'prefit_max_win_probability_residual':max(map(abs,prefit.values())),
                'final_max_win_probability_residual':max(map(abs,posterior.values())),
                'final_win_probability_residuals':posterior,
                'final_max_stage_residual':max(map(abs,result['calibration_residuals'].values())),
                'calibration_converged':result['calibration_converged'],
                'max_fixed_weight_se_per_100':float(se.max()),
                'proposal':result.get('review_proposal'),
                'initial_prior_ess':float(np.sum(arrays['prior_weights'])**2/np.sum(np.asarray(arrays['prior_weights'])**2)),
                'team_payout_per_100':dict(zip(targets,means.tolist())),
                'team_fixed_weight_se_per_100':dict(zip(targets,se.tolist())),
                'max_path_conservation_error':float(np.max(np.abs(gross.sum(axis=1)-100))),
                'weighted_conservation_error':float(abs(means.sum()-100)),
                'support':result['support_sampling'],'calibration':result['calibration_diagnostics'],
            }
            # Retain compact private arrays for support and proposal diagnosis.
            np.savez_compressed(outdir/f'{name}-{seed}.npz', weights=w, gross=gross,
                wins=np.column_stack([arrays['wins'][t] for t in targets]),
                hits=np.column_stack([np.isin(np.arange(len(w)),arrays['hits'][(t,s)]) for t in targets for s in playoffs.STAGES]),
                teams=np.asarray(list(targets)), stages=np.asarray(playoffs.STAGES))
            (outdir/f'{name}-{seed}.json').write_text(json.dumps(summary,indent=2))
            print(json.dumps({k:v for k,v in summary.items() if k in ('solver','seed','seconds','ess','max_weight','prefit_max_win_probability_residual','final_max_win_probability_residual','final_max_stage_residual','max_path_conservation_error')}),flush=True)


if __name__ == '__main__':
    main()
