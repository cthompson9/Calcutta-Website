import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { eq, and, sql } from 'drizzle-orm';
import { GetMlbResultsResponse } from '@workspace/api-zod';
import { fixture, referenceGames, terminalGames, payload, markCovered, now, pool, series } from './mlbResults.fixture.mjs';
import { syncMlbEventsTx } from './mlbEventSync.ts';
import { getMlbResults } from './mlbResults.ts';
import { refreshMlbResults, mlbIdentityMigrationReady, mlbRefreshScope, mlbDiscoveryDates, emptyMlbCache } from './mlbRefresh.ts';
import { createMlbResultsRouter } from '../routes/mlbResults.ts';
const read=(f,overrides={})=>getMlbResults(13,{database:f.db,now,enabled:true,...overrides});
const sync=(f,games)=>f.db.transaction(tx=>syncMlbEventsTx(tx,pool,[payload(games)]));

test('activation and migration are independent gates; unavailable reads never invent zero values',async t=>{
  const f=await fixture(t,{migrate:false});
  assert.equal(await mlbIdentityMigrationReady(f.db),false);
  assert.equal((await refreshMlbResults(pool,{database:f.db,now,authorized:false})).ran,false);
  assert.match((await refreshMlbResults(pool,{database:f.db,now,authorized:true})).reason,/migration/);
  const report=await read(f);
  assert.equal(report.status,'unavailable');assert.equal(report.dollarsPerPoint,null);
  assert.equal(report.earnedPoints,null);assert.ok(report.teams.every(row=>row.gross===null&&row.points===null));
  assert.deepEqual(await f.db.select().from(f.schema.refreshJobStatesTable),[]);
  assert.equal(GetMlbResultsResponse.safeParse(report).success,true);
});
test('repeated matchup games persist individually; repeated refresh is idempotent and leaves XII unchanged',async t=>{
  const f=await fixture(t);
  const nflBefore=await f.db.select().from(f.schema.eventsTable).where(eq(f.schema.eventsTable.sport,'NFL'));
  const positionsBefore=await f.db.select().from(f.schema.positionsTable);
  await sync(f,referenceGames);await sync(f,referenceGames);await markCovered(f);
  await f.db.transaction(tx=>syncMlbEventsTx(tx,pool,[payload(referenceGames,'20261004'),payload(referenceGames,'20261005')]));
  const events=await f.db.select().from(f.schema.eventsTable).where(eq(f.schema.eventsTable.sport,'MLB'));
  assert.equal(events.length,13);
  const report=await read(f);
  assert.equal(report.status,'available');assert.equal(report.pot,23940);
  assert.equal(report.provisionalPoints,190);assert.equal(report.earnedPoints,38);assert.equal(report.dollarsPerPoint,126);
  assert.equal(report.consortia.length,1);assert.equal(report.consortia[0].name,'Alpha');
  assert.equal(report.consortia[0].gross,4788);assert.equal(report.consortia[0].cost,23940);
  assert.equal(report.teams.reduce((n,row)=>n+Math.round(row.gross*100),0),478800);
  assert.equal(GetMlbResultsResponse.safeParse(report).success,true);
  assert.deepEqual(await f.db.select().from(f.schema.eventsTable).where(eq(f.schema.eventsTable.sport,'NFL')),nflBefore);
  assert.deepEqual(await f.db.select().from(f.schema.positionsTable),positionsBefore);
  assert.equal(await getMlbResults(12,{database:f.db,now,enabled:true}),null);
  const slots=await f.db.select().from(f.schema.calendarSlotsTable);
  const games=await f.db.select().from(f.schema.calendarGamesTable);
  assert.equal(slots.length,11);assert.equal(games.length,53);
  assert.ok(slots.filter(s=>s.homeSourceSlotId!=null||s.awaySourceSlotId!=null).length>=4);
  const overdue=await read(f,{now:new Date(now.getTime()+20*60000)});
  assert.equal(overdue.refresh.stale,true);assert.equal(overdue.dollarsPerPoint,126);
});
test('calendar series slots stay stable as advancing matchups appear',async t=>{
  const f=await fixture(t);
  await sync(f,referenceGames.filter(g=>g.homeTeamId!==10));
  const before=await f.db.select().from(f.schema.calendarSlotCandidatesTable);
  await sync(f,referenceGames);
  const after=await f.db.select().from(f.schema.calendarSlotCandidatesTable);
  for(const candidate of before)assert.ok(after.some(c=>c.slotId===candidate.slotId&&c.participantId===candidate.participantId&&c.designation===candidate.designation));
});
test('corrected finals replay cumulatively without payout, ownership or award duplication',async t=>{
  const f=await fixture(t);await sync(f,referenceGames);await markCovered(f);
  const first=await read(f);
  const replacement=series('division_series',9,1,[9,9,9]);
  await sync(f,replacement);
  const next=await read(f);
  assert.equal(next.provisionalPoints,191);assert.equal(next.earnedPoints,49);
  assert.notEqual(first.teams.find(t=>t.teamId===3).gross,next.teams.find(t=>t.teamId===3).gross);
  await sync(f,replacement);assert.deepEqual(await read(f),next);
  const corrected=structuredClone(replacement);corrected[2].homeScore=1;corrected[2].awayScore=5;
  await sync(f,corrected);
  const reverted=await read(f);
  assert.equal(reverted.provisionalPoints,190);assert.equal(reverted.earnedPoints,44);
  assert.equal(reverted.teams.find(t=>t.teamId===9).sweepPoints,0);
});
test('overlapping rescheduled daily pages reconcile one identity; same-date score conflicts fail closed',async t=>{
  const f=await fixture(t);
  const game=payload(referenceGames);
  const moved=structuredClone(game);moved.provenance.requestedDate='20261006';
  moved.events.forEach(g=>g.date='2026-10-06T17:00:00Z');
  await f.db.transaction(tx=>syncMlbEventsTx(tx,pool,[moved,game]));
  const events=await f.db.select().from(f.schema.eventsTable).where(eq(f.schema.eventsTable.sport,'MLB'));
  assert.equal(events.length,13);assert.ok(events.every(e=>e.eventDate==='2026-10-06'));
  const conflict=structuredClone(moved);conflict.events[0].competitions[0].competitors[0].score='8';
  await assert.rejects(f.db.transaction(tx=>syncMlbEventsTx(tx,pool,[moved,conflict])),/Conflicting/);
});
test('terminal team, owner and consortium gross reconcile exactly; signed shorts remain visible',async t=>{
  const f=await fixture(t);await sync(f,terminalGames);await markCovered(f);
  await f.db.insert(f.schema.positionsTable).values([
    {entryId:9,bidderId:201,ownershipShare:'-.8000',costBasis:'-800.0000',source:'trade'},
    {entryId:9,bidderId:202,ownershipShare:'.8000',costBasis:'800.0000',source:'trade'},
  ]);
  const report=await read(f);
  assert.equal(report.tournamentComplete,true);assert.equal(report.provisionalPoints,176);
  assert.equal(report.teams.reduce((n,r)=>n+Math.round(r.gross*100),0),2394000);
  assert.equal(report.consortia[0].gross,23940);assert.equal(report.consortia[0].net,0);
  assert.equal(report.teams.flatMap(r=>r.owners).reduce((n,r)=>n+Math.round(r.gross*100),0),2394000);
  assert.ok(report.teams.find(r=>r.teamId===9).owners.find(o=>o.bidderId===201).gross<0);
});
test('cross-pool prices and rubrics remain selected-pool scoped',async t=>{
  const f=await fixture(t);await sync(f,referenceGames);await markCovered(f);
  await f.db.insert(f.schema.calcuttasTable).values({...pool,id:14,name:'Other MLB pool'});
  await f.db.insert(f.schema.calcuttaEntriesTable).values({id:200,calcuttaId:14,teamId:9});
  await f.db.insert(f.schema.positionsTable).values({entryId:200,bidderId:201,ownershipShare:'1.0000',costBasis:'999999',source:'primary'});
  await f.db.insert(f.schema.calcuttaRulesTable).values({calcuttaId:14,ruleName:'WC Round Win',value:'999'});
  const report=await read(f);assert.equal(report.pot,23940);assert.equal(report.provisionalPoints,190);
  const other=await getMlbResults(14,{database:f.db,now,enabled:true});
  assert.equal(other.pot,null);assert.equal(other.dollarsPerPoint,null);
});
test('bounded discovery persists coverage across runs, fetch failures retain actuals, retries survive restart',async t=>{
  const f=await fixture(t);await sync(f,referenceGames);await markCovered(f);
  let calls=0;
  const failed=()=>refreshMlbResults(pool,{database:f.db,now,force:true,authorized:true,
    fetchDate:async()=>{calls++;throw new Error('ESPN test failure');}});
  await assert.rejects(failed(),/test failure/);
  const retained=await read(f);
  assert.equal(retained.status,'partial');assert.equal(retained.provisionalPoints,190);assert.equal(retained.refresh.stale,true);
  const beforeCalls=calls;
  const restart=await refreshMlbResults(pool,{database:f.db,now:new Date(now.getTime()+60000),authorized:true,fetchDate:async d=>{calls++;return payload([],d);}});
  assert.equal(restart.reason,'retry-backoff');assert.equal(calls,beforeCalls);
  const recovered=await refreshMlbResults(pool,{database:f.db,now:new Date(now.getTime()+6*60000),authorized:true,fetchDate:async d=>payload([],d)});
  assert.equal(recovered.ran,true);assert.equal((await read(f,{now:new Date(now.getTime()+6*60000)})).refresh.stale,false);
  assert.equal((await f.db.select().from(f.schema.eventsTable).where(eq(f.schema.eventsTable.sport,'MLB'))).length,13);
});
test('refresh transaction rolls back failed calendar rebuilding and coalesces durable leases',async t=>{
  const f=await fixture(t);await markCovered(f);
  let release, started;const ready=new Promise(resolve=>started=resolve);const wait=new Promise(resolve=>release=resolve);
  const attempt=refreshMlbResults(pool,{database:f.db,now,force:true,authorized:true,fetchDate:async d=>{started();await wait;return payload(d==='20261005'?referenceGames:[],d);}});
  await ready;
  const concurrent=await refreshMlbResults(pool,{database:f.db,now,force:true,authorized:true,fetchDate:async()=>{throw new Error('must not fetch');}});
  assert.equal(concurrent.reason,'already-running');release();assert.equal((await attempt).ran,true);
  await f.pg.exec(`ALTER TABLE calendar_games ADD CONSTRAINT fixture_failure CHECK (game_number <> 2) NOT VALID;`);
  await assert.rejects(refreshMlbResults(pool,{database:f.db,now:new Date(now.getTime()+6*60000),force:true,authorized:true,
    fetchDate:async d=>payload(d==='20261005'?series('division_series',9,1,[9,9,9]):[],d)}));
  const games=await f.db.select().from(f.schema.eventsTable).where(eq(f.schema.eventsTable.sport,'MLB'));
  assert.equal(games.length,13);assert.equal(games.find(g=>g.sourceEventId==='division_series:9:1:1').status,'scheduled');
});
test('missing source coverage or rules remain unavailable rather than an NFL fallback',async t=>{
  const f=await fixture(t);await sync(f,referenceGames);
  await f.db.insert(f.schema.refreshJobStatesTable).values({seasonId:1,sport:'MLB',competition:'MLB_POSTSEASON',job:'realized:13',
    scheduleCache:{...emptyMlbCache(),covered:{'20261005':now.toISOString()}},lastSucceededAt:now});
  assert.equal((await read(f)).dollarsPerPoint,null);
  await markCovered(f);
  await f.db.update(f.schema.calcuttaRulesTable).set({active:false}).where(and(eq(f.schema.calcuttaRulesTable.calcuttaId,13),eq(f.schema.calcuttaRulesTable.ruleName,'WC Bye')));
  const report=await read(f);assert.equal(report.provisionalPoints,null);assert.equal(report.teams[0].gross,null);
  assert.match(report.reasons.join(),/Missing MLB rule/);
});
test('REST returns the shared validated projection, scopes reads and protects manual retries',async t=>{
  const f=await fixture(t);await sync(f,referenceGames);await markCovered(f);
  const app=express();app.use(createMlbResultsRouter({read:id=>getMlbResults(id,{database:f.db,now,enabled:true})}));
  const server=app.listen(0,'127.0.0.1');t.after(()=>new Promise(resolve=>server.close(resolve)));
  await new Promise(resolve=>server.on('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(`${base}/calcuttas/13/mlb-results`);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),await read(f));
  assert.equal((await fetch(`${base}/calcuttas/12/mlb-results`)).status,404);
  assert.equal((await fetch(`${base}/calcuttas/1.5/mlb-results`)).status,400);
  assert.ok([401,403].includes((await fetch(`${base}/calcuttas/13/mlb-results/refresh`,{method:'POST'})).status));
});
