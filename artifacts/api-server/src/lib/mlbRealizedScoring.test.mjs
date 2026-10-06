import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMlbActuals, allocateMlbCents, parseMlbRules } from './mlbRealizedScoring.ts';
import { allocateSignedMlbCents } from './mlbResults.ts';
import { getCompetitionScoringAdapter, getSeriesActualsAdapter } from './competitionScoring.ts';
import { referenceGames, terminalGames, rules, ruleRows, ids, series } from './mlbResults.fixture.mjs';
const score=(games=referenceGames,r=rules)=>calculateMlbActuals(games,r,ids);

test('accepts saved points calculations and WS Sweep alias without weakening modifiers',()=>{
  const saved=ruleRows.map(row=>({...row,calculation:'points',
    ruleName:row.ruleName==='World Series Sweep'?'WS Sweep':row.ruleName}));
  assert.deepEqual(parseMlbRules(saved),rules);
  assert.throws(()=>parseMlbRules([...saved,{...saved.at(-1),ruleName:'World Series Sweep'}]),/duplicate/);
  assert.throws(()=>parseMlbRules(saved.map((r,i)=>i? r:{...r,calculation:'multiply'})),/modifiers/);
});

test('approved WC actuals 18 plus bye 20 yields 190, not a forced 170 or NFL denominator',()=>{
  const result=score();
  assert.deepEqual(result.reasons,[]);
  assert.deepEqual(result.rounds.map(r=>r.inventoryPoints),[38,40,56,56]);
  assert.equal(result.denominator,190);assert.equal(result.earnedPoints,38);
  assert.equal(result.rounds[0].gamePoints,9);assert.equal(result.rounds[0].sweepPoints,9);
  assert.equal(result.rounds[0].byePoints,20);
  for(const id of [9,10,11,12])assert.equal(result.points.get(id).bye,5);
  assert.equal(23940/result.denominator,126);
});
test('unplayed inventory is not an earned award; partial progress never double-counts games',()=>{
  const games=[...referenceGames.filter(g=>g.round!=='division_series'),
    ...series('division_series',9,1,[9,1,9]),...referenceGames.filter(g=>g.round==='division_series'&&g.homeTeamId!==9)];
  const result=score(games);
  assert.equal(result.denominator,190);assert.equal(result.points.get(9).total,9);
  assert.equal(result.rounds[1].gamePoints,6);assert.equal(result.rounds[1].inventoryPoints,40);
});
test('completed best-of-five sweep replaces ten provisional points with six plus five',()=>{
  const games=[...referenceGames.filter(g=>g.round!=='division_series'||g.homeTeamId!==9),...series('division_series',9,1,[9,9,9])];
  const result=score(games);assert.equal(result.denominator,191);
  assert.equal(result.points.get(9).total,16);assert.equal(result.rounds[1].inventoryPoints,41);
  assert.equal(result.series.find(s=>s.round==='division_series'&&s.homeTeam==='Team 9').sweep,true);
});
test('Game 7 progress remains seven games until a winner clinches; actual sixth-game finish shrinks it',()=>{
  const base=terminalGames.filter(g=>g.round==='wild_card'||g.round==='division_series');
  const before=score([...base,...series('league_championship',9,10,[9,10,9,10,9,10])]);
  assert.equal(before.denominator,194);assert.deepEqual(before.reasons,[]);
  assert.equal(score([...base,...series('league_championship',9,10,[9,10,9,10,9,9])]).denominator,190);
  assert.equal(score([...base,...series('league_championship',9,10,[9,10,9,10,9,10,9])]).denominator,194);
});
test('post-clinch games and suspended scores cannot award points',()=>{
  const extra=series('division_series',9,1,[9,9,9,1,1]);
  const result=score([...referenceGames.filter(g=>g.round!=='division_series'||g.homeTeamId!==9),...extra]);
  assert.equal(result.points.get(1).game,2);
  assert.deepEqual(result.series.find(s=>s.round==='division_series'&&s.homeTeam==='Team 9').games.slice(3).map(g=>g.status),['unneeded','unneeded']);
  const suspended=series('division_series',9,1,[9])[0];suspended.status='suspended';
  assert.equal(score([...referenceGames.filter(g=>g.round!=='division_series'||g.homeTeamId!==9),suspended]).points.get(9).game,0);
});
test('duplicate replay is idempotent; corrected finals fully replace wins and sweeps',()=>{
  assert.equal(score([...referenceGames,...referenceGames]).earnedPoints,38);
  const revised=structuredClone(referenceGames);
  const game=revised.find(g=>g.round==='wild_card'&&g.homeTeamId===3&&g.gameNumber===2);
  game.homeScore=1;game.awayScore=5;
  const result=score(revised);
  assert.ok(result.reasons.some(r=>r.includes('bye evidence')));
  assert.equal(result.points.get(3).sweep,0);assert.equal(result.points.get(4).game,1);
});
test('bye and final coverage gaps are explicit, never four guessed awards',()=>{
  const missing=score(referenceGames.filter(g=>g.homeTeamId!==12));
  assert.match(missing.reasons.join(),/bye evidence/);
  assert.equal(missing.rounds[0].byePoints,0);
  const gap=score(referenceGames.filter(g=>g.round!=='wild_card'||g.homeTeamId!==1||g.gameNumber!==1));
  assert.match(gap.reasons.join(),/coverage/);
});
test('stored rules are authoritative, missing/duplicate/unsupported/zero rules fail visibly',()=>{
  assert.throws(()=>parseMlbRules(ruleRows.slice(1)),/Missing/);
  assert.throws(()=>parseMlbRules([...ruleRows,ruleRows[0]]),/duplicate/);
  assert.throws(()=>parseMlbRules(ruleRows.map(r=>({...r,value:0}))),/no payable/);
  assert.throws(()=>parseMlbRules(ruleRows.map((r,i)=>i? r : {...r,multiplier:2})),/modifiers/);
  const changed={...rules,'LCS Win':5,'World Series Win':10};
  assert.equal(score(referenceGames,changed).denominator,218);
});
test('terminal gross values conserve the entire pot to the cent, including tiny pots',()=>{
  const result=score(terminalGames);assert.deepEqual(result.reasons,[]);
  assert.equal(result.complete,true);assert.equal(result.earnedPoints,176);assert.equal(result.denominator,176);
  for(const cents of [1,7,101,2394000]){
    assert.equal([...allocateMlbCents(cents,result.denominator,result.points).values()].reduce((a,b)=>a+b,0),cents);
  }
  assert.throws(()=>allocateMlbCents(10,0,result.points),/Invalid/);
});
test('signed owner cent allocation conserves gross through long and short positions',()=>{
  for(const target of [1,3,1001]){
    const allocated=allocateSignedMlbCents(target,[{id:1,numerator:BigInt(target)*-4667n},{id:2,numerator:BigInt(target)*14667n}],10000n);
    assert.equal([...allocated.values()].reduce((a,b)=>a+b,0),target);
    assert.ok(allocated.get(1)<=0);assert.ok(allocated.get(2)>=target);
  }
});
test('format dispatch separates variable MLB actuals from unchanged NFL fixed marks',()=>{
  assert.equal(getSeriesActualsAdapter('MLB','MLB_POSTSEASON').supportsProjectedMtm,false);
  assert.equal(getSeriesActualsAdapter('NFL','MLB_POSTSEASON'),undefined);
  assert.equal(getCompetitionScoringAdapter('NFL','NFL_REGULAR_SEASON').normalizationDenominator,11420);
  assert.equal(getCompetitionScoringAdapter('MLB','MLB_POSTSEASON'),undefined);
});
