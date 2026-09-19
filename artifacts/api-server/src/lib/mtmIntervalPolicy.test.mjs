import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERVAL_POLICY, selectedMtmPolicy, validateMtmPolicyIdentity, validateFinalIntervalMarketQuality } from './mtmIntervalPolicy.ts';

export function intervalFixture() {
  const teams=Array.from({length:32},(_,i)=>'T'+i), outcomes=['REG','WC','DIV','CONF','FL','FW'];
  const rows=teams.flatMap(team=>outcomes.map(outcome=>({id:`${team}-${outcome}`,team,outcome,family:'elimination',
    eligible:true,bounds:{lower:0,upper:1},captured_at:'2026-09-15T11:59:00Z'})));
  const report={policy_version:INTERVAL_POLICY,review_only:false,publishable:true,status:'shadow_candidate',
    numerical_checks_pass:true,solver_status:'converged',blockers:[],pricing_basis:'joint_market_intervals',
    decisions:rows.map(r=>({...r,mode:'hard',reason:'accepted_book'}))};
  const engine={model:{name:INTERVAL_POLICY,pricing_policy:INTERVAL_POLICY,pricing_basis:'joint_market_intervals'},
    projections:Object.fromEntries(teams.map(t=>[t,{p_stage:{berth:14/32,divisional:8/32,conference:4/32,sb_berth:2/32,sb_win:1/32}}])),
    diagnostics:{market_policy:report}};
  const state={realized:Object.fromEntries(teams.map(t=>[t,{wins:0}])),
    market_evidence_review:{schema_version:'market-policy-input-v1',evaluation_time:'2026-09-15T12:00:00Z',rows}};
  return {engine,state,config:{sim:{pricing_policy:INTERVAL_POLICY}}};
}
const check=f=>validateFinalIntervalMarketQuality(f.engine,f.state,f.config);
test('interval route accepts books independently of incompatible legacy point targets',()=>{
  const f=intervalFixture();f.engine.calibration=[{metric:'berth',target_probability:1,simulated_probability:0}];
  assert.equal(check(f).error,null);
});
test('unknown policy and wrong actual runner fail closed',()=>{
  assert.throws(()=>selectedMtmPolicy({sim:{pricing_policy:'typo'}}));
  const f=intervalFixture();f.engine.model.name='old';delete f.engine.model.pricing_policy;
  assert.match(validateMtmPolicyIdentity(f.engine,f.config),/mismatch/);
});
test('hard interval residual is independently recomputed despite success claims',()=>{
  const f=intervalFixture();f.state.market_evidence_review.rows[0].bounds={lower:.9,upper:1};
  f.engine.diagnostics.market_policy.decisions[0].bounds={lower:.9,upper:1};
  assert.match(check(f).error,/unmet interval/);
});
test('missing duplicates stale and malformed probabilities fail',()=>{
  for(const mutate of [f=>f.state.market_evidence_review.rows.pop(),
    f=>f.state.market_evidence_review.rows.push(f.state.market_evidence_review.rows[0]),
    f=>f.state.market_evidence_review.rows[0].captured_at='2026-09-15T10:00:00Z',
    f=>f.engine.projections.T0.p_stage.berth=null,
    f=>f.engine.diagnostics.market_policy.blockers.push({reason:'unresolved'})]) {
    const f=intervalFixture();mutate(f);assert.ok(check(f).error);
  }
});
test('soft exception cannot be asserted without timestamped trade and stronger wins',()=>{
  const f=intervalFixture();f.engine.diagnostics.market_policy.decisions[0].mode='soft';
  assert.match(check(f).error,/unmet interval/);
});
test('qualified trade and tighter wins permit an audited soft exception',()=>{
  const f=intervalFixture(),r=f.state.market_evidence_review.rows[0],d=f.engine.diagnostics.market_policy.decisions[0];
  r.bounds={lower:.7,upper:.9};r.material_event_at='2026-09-15T11:50:00Z';
  r.trades=[{id:'trade',timestamp:'2026-09-15T11:58:00Z',price:.8,size:2}];
  Object.assign(d,{bounds:r.bounds,mode:'soft',reason:'fresh_tighter_wins_preferred_after_trade_check',penalty:25,win_implied_probability:.3});
  f.state.market_evidence_review.rows.push(...[8,9].map(n=>({id:'w'+n,team:'T0',family:'wins',outcome:String(n),
    eligible:true,bounds:{lower:.49,upper:.51},captured_at:'2026-09-15T11:59:00Z'})));
  f.engine.model.pricing_basis=f.engine.diagnostics.market_policy.pricing_basis='wins_led';
  assert.equal(check(f).error,null);
  r.trades[0].timestamp='2026-09-15T11:49:00Z';assert.match(check(f).error,/unmet interval/);
});
test('wide conflicting book can use Last as independently audited low-weight context',()=>{
  const f=intervalFixture(),r=f.state.market_evidence_review.rows[0],d=f.engine.diagnostics.market_policy.decisions[0];
  r.bounds={lower:.7,upper:.9};r.last_price=.8;
  Object.assign(d,{bounds:r.bounds,mode:'soft',reason:'wide_book_with_last_context',penalty:5,
    last_price_context:.8,win_implied_probability:.3});
  f.state.market_evidence_review.rows.push(...[8,9].map(n=>({id:'w'+n,team:'T0',family:'wins',outcome:String(n),
    eligible:true,bounds:{lower:.49,upper:.51},captured_at:'2026-09-15T11:59:00Z'})));
  f.engine.model.pricing_basis=f.engine.diagnostics.market_policy.pricing_basis='wins_led';
  assert.equal(check(f).error,null);
  d.last_price_context=.7;assert.match(check(f).error,/unmet interval/);
});
