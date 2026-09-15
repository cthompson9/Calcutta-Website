"""Market interval fitter shared by the canonical adapter and offline shadow.

Books define intervals. Qualified recent executions are corroboration only.
Win evidence may take precedence over conflicting wide playoff evidence when
its freshness and tighter spread are demonstrated. Every exception is retained.
"""
from __future__ import annotations
import argparse
from datetime import datetime
import json
import math
import os
from pathlib import Path
import time
import numpy as np

VERSION = 'market-interval-win-priority-shadow-v1'
DEFAULTS = dict(max_age_seconds=900, wide_spread=.10, wide_relative_spread=.50,
    tight_win_spread=.05, min_win_rungs=2, material_gap=.03, min_trade_size=1,
    weak_penalty=25.0, max_seconds=30, max_iterations=1000,
    numerical_tolerance=1e-6, min_ess=2000, max_weight=.01, win_tolerance=.03)
OUTCOMES = ['no_playoffs', 'wild_card', 'divisional', 'conference', 'sb_loss', 'sb_win']
ALIASES = dict(zip(['REG','WC','DIV','CONF','FL','FW'],OUTCOMES))
STAGES = ['berth','divisional','conference','sb_berth','sb_win']

def timestamp(value):
    try:
        dt=datetime.fromisoformat(value.replace('Z','+00:00'))
        return dt.timestamp() if dt.tzinfo is not None else None
    except (ValueError,TypeError,AttributeError):return None

def finite(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)

def eligible_book(row, now, policy):
    b=row.get('bounds',{});lo=b.get('lower');hi=b.get('upper')
    if row.get('eligible') is not True or not finite(lo) or not finite(hi) or not 0<=lo<=hi<=1:return False
    if row.get('resolved') is True:return lo==hi and lo in (0,1)
    captured=timestamp(row.get('captured_at'));cutoff=timestamp(row.get('material_event_at'))
    if row.get('material_event_at') is not None and cutoff is None:return False
    return captured is not None and 0<=now-captured<=policy['max_age_seconds'] and (cutoff is None or captured>=cutoff)

def latest_trade(row, now, policy):
    """Never use last_price or a fetch timestamp as an execution timestamp."""
    candidates=[];rejected=[];cutoff=timestamp(row.get('material_event_at'))
    for trade in row.get('trades') or []:
        at=timestamp(trade.get('timestamp'));price=trade.get('price');size=trade.get('size')
        reason=None
        if not isinstance(trade.get('id'),str) or not trade['id']:reason='missing_trade_id'
        elif at is None:reason='missing_execution_time'
        elif not 0<=now-at<=policy['max_age_seconds']:reason='stale_or_future_trade'
        elif row.get('material_event_at') is not None and cutoff is None:reason='invalid_event_cutoff'
        elif cutoff is not None and at<cutoff:reason='trade_before_material_event'
        elif not finite(size) or size<policy['min_trade_size']:reason='insufficient_trade_size'
        elif not finite(price) or not 0<=price<=1:reason='invalid_trade_price'
        if reason:rejected.append({'id':trade.get('id'),'reason':reason})
        else:candidates.append((at,trade['id'],trade))
    if not candidates:return {'status':'unavailable','trade':None,'rejected':rejected,'bare_last_price':row.get('last_price')}
    newest=max(at for at,_,_ in candidates)
    same_time=[t for at,_,t in candidates if at==newest]
    # Conflicting duplicate IDs/timestamps must not become order-dependent.
    if len({(t['price'],t['size']) for t in same_time})>1:
        return {'status':'ambiguous','trade':None,'rejected':rejected}
    trade=sorted(same_time,key=lambda t:t['id'])[0]
    b=row['bounds']
    status='usable' if b['lower']<=trade['price']<=b['upper'] else 'outside_book'
    return {'status':status,'trade':trade,'rejected':rejected}

def win_quality(rows, now, policy):
    result={}
    for team in sorted({r.get('team') for r in rows if isinstance(r.get('team'),str)}):
        central={}
        for r in rows:
            if r.get('team')!=team or r.get('family')!='wins' or r.get('resolved') or not eligible_book(r,now,policy):continue
            lo=r['bounds']['lower'];hi=r['bounds']['upper'];mid=(lo+hi)/2
            if .1<=mid<=.9:central[str(r.get('outcome'))]=hi-lo
        widths=list(central.values());median=float(np.median(widths)) if widths else None
        result[team]={'qualified':len(widths)>=policy['min_win_rungs'] and median<=policy['tight_win_spread'],
            'central_rungs':len(widths),'median_spread':median,
            'basis':'fresh central-rung spread proxy; not a claim of observed traded liquidity'}
    return result

def select_playoff_constraint(row, win_implied, quality, now, policy):
    b=row['bounds'];width=b['upper']-b['lower'];mid=(b['upper']+b['lower'])/2
    gap=max(0,b['lower']-win_implied,win_implied-b['upper'])
    wide=width>=policy['wide_spread'] or width/max(mid,.01)>=policy['wide_relative_spread']
    decision={'id':row['id'],'team':row['team'],'outcome':row['outcome'],'bounds':b,
        'win_implied_probability':win_implied,'interval_gap':gap,'wide':wide,
        'mode':'hard','reason':'accepted_book','trade_check':latest_trade(row,now,policy) if wide else None}
    if row.get('resolved'):
        decision['reason']='settlement_fact';return decision
    if not wide or gap<=policy['material_gap']:return decision
    if not quality.get('qualified') or quality['median_spread']>=width:
        decision['reason']='wins_not_demonstrably_stronger';return decision
    if timestamp(row.get('material_event_at')) is None:
        decision.update(reason='needs_information_cutoff',blocked=True);return decision
    check=decision['trade_check']
    if check['status']!='usable':
        decision.update(reason='needs_trade_evidence',blocked=True);return decision
    if abs(check['trade']['price']-win_implied)<=policy['material_gap']:
        decision.update(reason='book_trade_disagreement',blocked=True);return decision
    decision.update(mode='soft',reason='fresh_tighter_wins_preferred_after_trade_check',penalty=policy['weak_penalty'])
    return decision

def captured_win_targets(rows, now, policy, config):
    import wins as win_module
    ladders={}
    for row in rows:
        if row.get('family')!='wins' or not eligible_book(row,now,policy):continue
        strike=int(row['outcome']);b=row['bounds'];settled=row.get('resolved') is True
        if str(strike)!=str(row['outcome']) or not 1<=strike<=17:raise ValueError('invalid win strike')
        ladder=ladders.setdefault(row['team'],{})
        if strike in ladder:raise ValueError('duplicate team win strike')
        ladder[strike]=win_module.Rung(strike,b['lower'],b['upper'],0,
            'settled' if settled else 'active',('yes' if b['lower']==1 else 'no') if settled else None)
    return {t:win_module.expected_wins_from_ladder([ladder[k] for k in sorted(ladder)],
        config['games_per_team'],config['pricing']['max_spread_for_mid'])['e_wins'] for t,ladder in ladders.items()}

def generate_inventory(state, capture, config, seed, runs=40000):
    """Rebuild ratings and path priors from this capture; no previous weights."""
    import simulate
    from schedule_feasible_fit import fit_schedule_feasible_candidate
    from importance_sampling_review import MarginMixtureProposal
    if os.environ.get('PYTHONHASHSEED')!='0':raise ValueError('set PYTHONHASHSEED=0 for reproducible bracket ordering')
    targets=captured_win_targets(capture['rows'],timestamp(capture['evaluation_time']),DEFAULTS,config)
    teams=list(state['realized'])
    if set(targets)!=set(teams):raise ValueError('incomplete captured win evidence')
    remaining={t:max(0,targets[t]-state['realized'][t]['wins']) for t in teams}
    sc=config['sim'];fit=fit_schedule_feasible_candidate(remaining,
        [{k:g[k] for k in ('home','away','week','event_id') if k in g} for g in state['remaining_schedule']],
        hfa=sc['hfa_points'],margin_sd=sc['margin_sd'])
    if fit['status']!='ok':raise ValueError('fresh rating fit failed')
    # Broad fixed proposal; no within-batch selection of favorable teams.
    proposal=MarginMixtureProposal(teams)
    result=simulate.monte_carlo(fit['ratings'],[simulate.Game(**g) for g in state['remaining_schedule']],
        {t:state['realized'][t]['wins'] for t in teams},state['divisions'],hfa=sc['hfa_points'],margin_sd=sc['margin_sd'],
        runs=runs,seed=seed,rubric=config['rubric'],pot=100,realized_stats=state['realized'],
        review_proposal=proposal,return_review_arrays=True)
    a=result['_review_arrays']
    inventory={'prior':np.asarray(a['prior_weights']),'teams':np.asarray(teams),'stages':np.asarray(STAGES),
        'wins':np.column_stack([a['wins'][t] for t in teams]),'gross':np.column_stack([a['gross'][t] for t in teams]),
        'outcomes':np.asarray(a['outcomes'],dtype=np.uint8),
        'raw_diff':np.column_stack([a['raw_diff'][t] for t in teams]),
        'adjusted_diff':np.column_stack([a['adjusted_diff'][t] for t in teams]),
        'hits':np.column_stack([np.isin(np.arange(runs),a['hits'][(t,s)]) for t in teams for s in STAGES])}
    return inventory,{'source':'fresh rating fit from captured win books','seed':seed,'runs':runs,
        'rating_fit':fit,'proposal':proposal.diagnostics()}

def fit_intervals(features, prior, lower, upper, penalties, policy):
    """KL projection with exact intervals or squared-distance soft penalties.

    Infinity penalty means hard. Soft dual variables pay xÂ²/(4*penalty).
    Timeouts retain an accepted iterate and are never treated as convergence.
    """
    from scipy import sparse
    from scipy.optimize import minimize
    from scipy.special import logsumexp
    start=time.monotonic();F=sparse.csr_matrix(features,dtype=float);FT=F.T.tocsr()
    p=np.asarray(prior,dtype=float);lo=np.asarray(lower,dtype=float);hi=np.asarray(upper,dtype=float)
    rho=np.asarray(penalties,dtype=float);m,n=F.shape
    if p.shape!=(n,) or lo.shape!=(m,) or hi.shape!=(m,) or rho.shape!=(m,):raise ValueError('shape mismatch')
    if not np.isfinite(F.data).all() or not np.isfinite(p).all() or np.any(p<=0):raise ValueError('invalid features/prior')
    if not np.isfinite(lo).all() or not np.isfinite(hi).all() or np.any(lo>hi) or np.any(rho<=0) or np.isnan(rho).any():raise ValueError('invalid intervals/penalties')
    p=p/p.sum();lp=np.log(p);hard=np.isinf(rho)
    minimum=F.min(axis=1).toarray().ravel();maximum=F.max(axis=1).toarray().ravel()
    unsupported=np.flatnonzero(hard&((maximum<lo)|(minimum>hi)))
    if len(unsupported):return {'status':'unsupported','unsupported_rows':unsupported.tolist(),'weights':None}
    cap_fail=[]
    for i in np.flatnonzero(hard):
        values=F.getrow(i)
        if np.isin(values.data,[0,1]).all():
            count=int(values.sum());cap=policy['max_weight']
            if lo[i]>min(1,count*cap)+1e-12 or hi[i]<max(0,1-(n-count)*cap)-1e-12:cap_fail.append(int(i))
    if cap_fail:return {'status':'insufficient_support_for_weight_cap','unsupported_rows':cap_fail,'weights':None}
    invrho=np.where(hard,0,1/rho);accepted={};history=[]
    def objective(x):
        mass=lp+FT@(x[:m]-x[m:]);z=logsumexp(mass);w=np.exp(mass-z);a=F@w
        loss=z-lo@x[:m]+hi@x[m:]+.25*np.sum(invrho*(x[:m]**2+x[m:]**2))
        gradient=np.r_[a-lo+.5*invrho*x[:m],hi-a+.5*invrho*x[m:]]
        return float(loss),gradient,w,a
    class BudgetExceeded(Exception):pass
    def callback(x):
        loss,_,w,a=objective(x);accepted.update(weights=w,achieved=a,loss=loss)
        history.append(loss)
        if time.monotonic()-start>=policy['max_seconds']:raise BudgetExceeded()
    try:
        result=minimize(lambda x:objective(x)[:2],np.zeros(2*m),jac=True,method='L-BFGS-B',
            bounds=[(0,None)]*(2*m),callback=callback,
            options={'maxiter':policy['max_iterations'],'ftol':1e-12,'gtol':1e-8,'maxls':30})
        _,_,w,a=objective(result.x)
        status='converged' if result.success else 'not_converged';message=str(result.message)
    except BudgetExceeded:
        w=accepted['weights'];a=accepted['achieved'];status='timeout';message='last accepted iterate retained'
    residual=np.maximum.reduce([lo-a,a-hi,np.zeros(m)])
    maxhard=float(residual[hard].max()) if hard.any() else 0
    if status=='converged' and maxhard>policy['numerical_tolerance']:status='hard_constraints_failed'
    return {'status':status,'message':message,'weights':w,'achieved':a,'residuals':residual,
        'max_hard_residual':maxhard,'iterations':len(history),'seconds':time.monotonic()-start}

def resolve_provisional_conflicts(decisions, blockers, residuals, *, converged,
                                  max_win_error, policy):
    """A satisfied hard constraint needs no permission to override evidence.

    Keep the pre-fit finding for audit. Resolve only provisional exception
    evidence requests, after the joint fit meets every hard constraint and wins.
    """
    resolved=set()
    joint_ok=(converged and max_win_error<=policy['win_tolerance'] and
              all(r['violation']<=policy['numerical_tolerance']
                  for r in residuals if r['mode']=='hard'))
    by_id={r['id']:r for r in residuals}
    for d in decisions:
        r=by_id.get(d['id'])
        if (joint_ok and d.get('blocked') and d['mode']=='hard' and
            d['reason'] in {'needs_information_cutoff','needs_trade_evidence','book_trade_disagreement'} and
            r and r['mode']=='hard' and r['violation']<=policy['numerical_tolerance']):
            d.update(prefit_reason=d['reason'],reason='resolved_by_hard_joint_fit',
                     blocked=False,final_probability=r['achieved'],exception_applied=False)
            resolved.add(d['id'])
    return [b for b in blockers if b.get('id') not in resolved]


def run_shadow(state, capture, inventory, config, policy=None, *, result_arrays=None):
    policy=dict(DEFAULTS if policy is None else policy)
    if capture.get('schema_version')!='market-policy-input-v1':raise ValueError('unsupported evidence schema')
    now=timestamp(capture.get('evaluation_time'))
    if now is None:raise ValueError('invalid evaluation time')
    rows=capture['rows'];ids=[r['id'] for r in rows]
    if len(ids)!=len(set(ids)):raise ValueError('duplicate quote identity')
    teams=list(inventory['teams']);stages=list(inventory['stages']);prior=inventory['prior']
    win=inventory['wins'];hit=inventory['hits'].astype(float);gross=inventory['gross'];n=len(prior)
    if stages!=STAGES or set(teams)!=set(state['realized']):raise ValueError('team/stage inventory mismatch')
    if win.shape!=(n,len(teams)) or hit.shape!=(n,len(teams)*5) or gross.shape!=(n,len(teams)):raise ValueError('inventory shape mismatch')
    if not np.isfinite(win).all() or not np.isfinite(gross).all() or not np.isin(hit,[0,1]).all():raise ValueError('invalid path arrays')
    if not np.allclose(gross.sum(axis=1),100,atol=1e-9,rtol=0):raise ValueError('synthetic pool does not conserve')
    h=hit.reshape(n,len(teams),5)
    if np.any(np.diff(h,axis=2)>0) or not np.all(h.sum(axis=1)==[14,8,4,2,1]):raise ValueError('illegal playoff inventory')
    expected_total=sum(v['wins'] for v in state['realized'].values())+len(state['remaining_schedule'])
    if not np.allclose(win.sum(axis=1),expected_total,atol=1e-9,rtol=0):raise ValueError('season wins do not conserve')
    usable=[r for r in rows if eligible_book(r,now,policy)]
    captured_targets=captured_win_targets(rows,now,policy,config)
    quality=win_quality(rows,now,policy);features=[];lower=[];upper=[];penalties=[];names=[]
    blockers=[];mean_targets={}
    for ti,t in enumerate(teams):
        if t not in captured_targets:raise ValueError('no eligible captured win ladder for '+t)
        target=captured_targets[t]
        games=sum(g['home']==t or g['away']==t for g in state['remaining_schedule'])
        if games==0:raise ValueError('shadow runner currently requires remaining regular-season games')
        actual=state['realized'][t]['wins']
        if np.any(win[:,ti]<actual) or np.any(win[:,ti]>actual+games):raise ValueError('path violates realized wins')
        mean_targets[t]=max(0,target-actual)/games
        f=(win[:,ti].astype(float)-actual)/games
        features.append(f);lower.append(mean_targets[t]-policy['win_tolerance']+1e-6);upper.append(mean_targets[t]+policy['win_tolerance']-1e-6);penalties.append(math.inf);names.append('mean:'+t)
        if not any(r['team']==t and r['family']=='wins' for r in usable):blockers.append({'team':t,'reason':'missing_eligible_win_evidence'})
        found={ALIASES.get(r['outcome'],r['outcome']) for r in usable if r['team']==t and r['family']=='elimination'}
        if set(OUTCOMES)-found:blockers.append({'team':t,'reason':'incomplete_elimination_coverage','missing':sorted(set(OUTCOMES)-found)})
    baseline=fit_intervals(features,prior,lower,upper,penalties,policy)
    if baseline['status']!='converged':return {'policy_version':VERSION,'review_only':True,'publishable':False,'status':'win_baseline_failed','solver_status':baseline['status']}
    decisions=[]
    for r in usable:
        if r['family']!='elimination':continue
        ti=teams.index(r['team']);v=h[:,ti,:];label=ALIASES.get(r['outcome'],r['outcome'])
        if label not in OUTCOMES:raise ValueError('unknown elimination outcome')
        k=OUTCOMES.index(label);f=1-v[:,0] if k==0 else v[:,-1] if k==5 else v[:,k-1]-v[:,k]
        decision=select_playoff_constraint(r,float(baseline['weights']@f),quality[r['team']],now,policy)
        decisions.append(decision)
        if decision.get('blocked'):blockers.append({'id':r['id'],'reason':decision['reason']})
        features.append(f);lower.append(r['bounds']['lower']);upper.append(r['bounds']['upper'])
        penalties.append(decision.get('penalty',math.inf));names.append(r['id'])
    fit=fit_intervals(features,prior,lower,upper,penalties,policy)
    report={'policy_version':VERSION,'review_only':True,'publishable':False,'evaluation_time':capture['evaluation_time'],
        'settings':policy,'win_quality':quality,'decisions':decisions,'blockers':blockers,
        'solver_status':fit['status'],'status':'blocked','pricing_basis':'wins_led' if any(d['mode']=='soft' for d in decisions) else 'joint_market_intervals',
        'mean_win_target_source':'rebuilt from eligible win books in this capture; previous state win ladders are ignored',
        'not_a_full_win_ladder_fit':True,'constraint_count':len(features)}
    if fit['weights'] is None:
        report['unsupported_constraints']=[names[i] for i in fit['unsupported_rows']];return report
    w=fit['weights'];achieved=np.array(features)@w
    residual=np.maximum.reduce([np.array(lower)-achieved,achieved-np.array(upper),np.zeros(len(features))])
    ess=float(1/(w@w));maximum=float(w.max());maxwin=float(max(abs(achieved[i]-mean_targets[t]) for i,t in enumerate(teams)))
    hard=np.isinf(penalties);maxhard=float(residual[hard].max())
    numerical_pass=fit['status']=='converged' and maxhard<=policy['numerical_tolerance'] and ess>=policy['min_ess'] and maximum<=policy['max_weight'] and maxwin<=policy['win_tolerance']
    residual_rows=[{'id':names[i],'achieved':float(achieved[i]),'violation':float(residual[i]),'mode':'hard' if hard[i] else 'soft'} for i in range(len(names))]
    blockers=resolve_provisional_conflicts(decisions,blockers,residual_rows,
        converged=fit['status']=='converged',max_win_error=maxwin,policy=policy)
    report['blockers']=blockers
    p=np.asarray(prior,dtype=float);p=p/p.sum()
    report['weight_stages']={label:{'ess':float(1/(v@v)),'max_weight':float(v.max())}
        for label,v in [('prior',p),('after_wins',baseline['weights']),('final',w)]}
    # Private in-process boundary: never serialize path weights in snapshots.
    if result_arrays is not None:result_arrays.update(weights=w)
    report.update(numerical_checks_pass=numerical_pass,ess=ess,max_weight=maximum,max_mean_win_error=maxwin,
        max_hard_interval_violation=maxhard,max_any_interval_violation=float(residual.max()),
        pool_conservation_error=float(abs((w@gross).sum()-100)),
        team_payout_per_100=dict(zip(teams,(w@gross).tolist())),
        status='shadow_candidate' if numerical_pass and not blockers else 'blocked',
        constraint_residuals=residual_rows)
    return report

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['state','evidence','config','output']:p.add_argument('--'+name,required=True,type=Path)
    p.add_argument('--inventory',type=Path,help='Explicit fixed-inventory diagnostic; otherwise rebuild ratings and paths')
    p.add_argument('--seed',type=int,default=20260915)
    a=p.parse_args()
    state=json.loads(a.state.read_text());capture=json.loads(a.evidence.read_text());config=json.loads(a.config.read_text())
    if a.inventory:
        with np.load(a.inventory,allow_pickle=False) as archive:inventory={k:archive[k] for k in archive.files}
        provenance={'source':'explicit saved inventory; does not demonstrate fresh prior generation'}
    else:inventory,provenance=generate_inventory(state,capture,config,a.seed)
    report=run_shadow(state,capture,inventory,config)
    import hashlib
    report['provenance']={**provenance,'sha256':{name:hashlib.sha256(getattr(a,name).read_bytes()).hexdigest() for name in ['state','evidence','config']},
        'source_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2,allow_nan=False))
    print(json.dumps({k:report.get(k) for k in ['status','policy_version','publishable','numerical_checks_pass','ess','max_weight','max_mean_win_error']}))

if __name__=='__main__':main()
