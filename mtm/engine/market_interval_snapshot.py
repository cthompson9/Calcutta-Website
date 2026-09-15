"""Canonical snapshot adapter for the captured-book interval policy.

The fitter owns a single posterior. Every public statistic below is reduced
from that posterior, including game conditionals and point differentials.
"""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import numpy as np
import market_policy_review as policy
import simulate
import valuation

POLICY = 'market-interval-win-priority-v1'
LEGACY_POLICY = 'normalized-point-v2'


def selected_policy(config):
    selected = config.get('sim', {}).get('pricing_policy', LEGACY_POLICY)
    if selected not in (LEGACY_POLICY, POLICY):
        raise ValueError('unknown MTM pricing_policy: '+str(selected))
    return selected


def assemble_snapshot(config, state, inventory, generation, report, weights):
    """Pure payout bridge, also used by offline replay tests."""
    if report.get('status') != 'shadow_candidate':
        raise ValueError('interval fit did not pass publication prerequisites')
    teams=list(inventory['teams']);n=len(weights);w=np.asarray(weights,dtype=float)
    if (w.shape!=(len(inventory['prior']),) or not np.isfinite(w).all() or
        np.any(w<0) or not np.isclose(w.sum(),1,rtol=0,atol=1e-10)):
        raise ValueError('invalid final posterior')
    for key in ('raw_diff','adjusted_diff'):
        if inventory[key].shape!=(n,len(teams)) or not np.isfinite(inventory[key]).all():
            raise ValueError('invalid '+key+' inventory')
    if inventory['outcomes'].shape!=(len(state['remaining_schedule']),n) or not np.isin(inventory['outcomes'],[0,1]).all():
        raise ValueError('invalid game outcome inventory')
    ess=float(1/(w@w));maximum=float(w.max())
    if abs(ess-report['ess'])>1e-6 or abs(maximum-report['max_weight'])>1e-12:
        raise ValueError('posterior does not match fit diagnostics')
    sc=config['sim'];pot=float(state['pot']);schedule=[simulate.Game(**g) for g in state['remaining_schedule']]
    if not np.isfinite(pot) or pot<=0:raise ValueError('invalid pool')
    totals=simulate._aggregate_path_statistics(teams,inventory['outcomes'],
        {t:inventory['wins'][:,i] for i,t in enumerate(teams)},
        {t:inventory['gross'][:,i]*(pot/100) for i,t in enumerate(teams)},w*n)
    # The reducer returns the same aggregate schema as monte_carlo.
    mc={**totals,'runs':n,'effective_sample_size':ess,'max_weight':maximum,'calibration_converged':True}
    valued=valuation.value_simulation(config['rubric'],state['entries'],pot,mc,schedule,
        min_conditional_samples=sc.get('min_conditional_samples',100),
        min_conditional_share=sc.get('min_conditional_share',.01))
    win=w@inventory['wins'];raw=w@inventory['raw_diff'];adjusted=w@inventory['adjusted_diff']
    hit=(w@inventory['hits']).reshape(len(teams),5)
    targets=policy.captured_win_targets(state['market_evidence_review']['rows'],
        policy.timestamp(state['market_evidence_review']['evaluation_time']),policy.DEFAULTS,config)
    projections={};metrics=[]
    for i,t in enumerate(teams):
        realized=state['realized'][t]['wins'];games=sum(g.home==t or g.away==t for g in schedule)
        projections[t]={'e_wins_total':float(win[i]),'e_remaining_wins':float(win[i]-realized),
            'e_remaining_ties':0.,'e_remaining_raw_diff':float(raw[i]),
            'e_remaining_marquee_addon':float(adjusted[i]-raw[i]),
            'p_stage':dict(zip(policy.STAGES,hit[i].tolist())),
            'rating':generation['rating_fit']['ratings'][t]}
        target=max(0,targets[t]-realized)/games;posterior=float((win[i]-realized)/games)
        metrics.append({'metric':'remaining_win_probability','team':t,
            'target_probability':target,'simulated_probability':posterior,'residual':posterior-target,
            'weight':games,'tolerance':report['settings']['win_tolerance'],'sample_count':n,
            'sample_share':1.,'effective_sample_size':ess,'quality_status':'good',
            'sample_metadata':{'posterior_probability':posterior,'calibration_basis':POLICY}})
    decisions={d['id']:d for d in report['decisions']}
    for r in report['constraint_residuals']:
        if r['id'] not in decisions:continue
        d=decisions[r['id']]
        metrics.append({'metric':'elimination_interval:'+policy.ALIASES.get(d['outcome'],d['outcome']),
            'team':d['team'],'simulated_probability':r['achieved'],'residual':r['violation'],
            'sample_count':n,'sample_share':1.,'effective_sample_size':ess,'quality_status':'good',
            'sample_metadata':{'quote_id':d['id'],'bounds':d['bounds'],'mode':d['mode']}})
    for row in valued['entries']:
        t=row['team'];row['expected_points']=valuation.value_team(config['rubric'],state['realized'][t],projections[t])['expected_points']
    return {'status':'ok','as_of':datetime.now(timezone.utc).isoformat(),'config_season':config['season'],
        'projections':projections,'valuations':valued['entries'],'team_valuations':valued['team_valuations'],
        'conditional_payouts':valued['conditional_payouts'],'path_count':n,
        'model':{'name':POLICY,'pricing_policy':POLICY,'pricing_basis':report['pricing_basis'],
            'seed':generation['seed'],'runs':n,'margin_sd':sc['margin_sd'],'hfa_points':sc['hfa_points']},
        'diagnostics':{'simulation':valued['diagnostics'],'rating_fit':generation['rating_fit'],
            'monte_carlo_sampling':{'effective_sample_size':ess,'max_weight':maximum},
            'market_policy':report,'generation':generation,
            'market_calibration':{'metrics':metrics,'status':'good','calibration_status':'good'}}}


def build_interval_snapshot(config, state, runtime):
    sc=config['sim'];seed=sc.get('seed',20260829);runs=sc['monte_carlo_runs']
    settings=dict(policy.DEFAULTS)
    gates=config.get('prototype_review',{})
    settings.update(min_ess=max(2000,runs*.05,float(gates.get('min_global_ess',2000)),
                               runs*float(gates.get('min_ess_fraction',.05))),
        max_weight=min(.01,float(gates.get('max_weight',.01))),
        win_tolerance=min(.03,float(sc.get('calibration_tolerance',.03))))
    with runtime.stage('interval_inventory'):
        try:
            inventory,generation=policy.generate_inventory(state,state['market_evidence_review'],config,seed,runs)
        except policy.RatingFitFailure as error:
            runtime.record_detail('rating_fit',error.fit)
            raise
    generation['proposal'].update(review_only=False,selection='fixed all-team mixture; no within-batch adaptation')
    result={}
    with runtime.stage('interval_fit'):
        report=policy.run_shadow(state,state['market_evidence_review'],inventory,config,settings,result_arrays=result)
    # Full effective config is also captured by the API before spawning Python.
    report.update(policy_version=POLICY,review_only=False,publishable=report.get('status')=='shadow_candidate')
    generation['source_sha256']={name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        for name in ('run_mtm.py','market_interval_snapshot.py','market_policy_review.py','simulate.py',
                     'importance_sampling_review.py','schedule_feasible_fit.py','valuation.py')}
    runtime.record_detail('market_policy',report)
    if report.get('status')!='shadow_candidate':
        return {'status':'failed','error':'Market interval fit failed quality checks; see market_policy diagnostics.',
            'as_of':datetime.now(timezone.utc).isoformat(),'path_count':runs,
            'model':{'name':POLICY,'pricing_policy':POLICY,'seed':seed},
            'diagnostics':{'market_policy':report,'generation':generation,'runtime':runtime.snapshot()}}
    with runtime.stage('interval_valuation'):
        snapshot=assemble_snapshot(config,state,inventory,generation,report,result['weights'])
    snapshot['diagnostics']['runtime']=runtime.snapshot()
    return snapshot
