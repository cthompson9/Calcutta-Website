import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LiveAuction,parseResult,validateDraft} from '../server/live-auction.mjs';

const context=()=>({protocolVersion:2,id:1,currentLotId:10,lots:[{id:10,displayName:'Chiefs',status:'bidding',nominationId:'nom-1'},{id:11,displayName:'Bills',status:'available',nominationId:null}],consortia:[{id:1,displayName:'Alpha',aliases:['A team'],active:1},{id:2,displayName:'Bravo',aliases:[],active:1}],sales:[]});
const binding={lotId:10,nominationId:'nom-1',safe:true};
function fixture() {
  let now=100000, ctx=context(), send=async r=>({idempotencyKey:r.idempotencyKey,saleId:50});
  const bridge={data:{pairing:{id:'session-1',origin:'https://thecalcutta.app',auction:{id:1}}},status:()=>({connected:true}),context:async()=>structuredClone(ctx),submitResult:r=>send(r)};
  const file=join(mkdtempSync(join(tmpdir(),'listener-live-')),'live.json');
  const live=new LiveAuction({file,bridge,now:()=>now});
  return {live,file,bridge,setTime:n=>now=n,getTime:()=>now,setContext:c=>ctx=c,setSend:fn=>send=fn};
}
function speech(text,{start=4,final=true,uploadId='upload-1',...rest}={}) {
  return {websiteSessionId:'session-1',uploadId,captureStartedAt:100000,event:{event:final?'transcript.data':'transcript.partial_data',data:{data:{participant:{id:'speaker-1'},words:[{text,start_timestamp:{relative:start},end_timestamp:{relative:start+1}}]}}},...rest};
}
test('exact roster aliases, explicit splits and final amounts become a ready result',()=>{
  for(const text of ['Sold to Alpha for $500','Chiefs sold to A team for five hundred dollars','Sold to Alpha and Bravo fifty-fifty for $500','Sold to Alpha 60 percent and Bravo 40 percent for $500']) {
    const d=parseResult(text,context(),binding);assert.deepEqual(d.issues,{});assert.equal(d.totalCents,50000);
  }
});
test('unknown/ambiguous winners, absent shares, invalid amount and wrong lot flag specific fields',()=>{
  assert.ok(parseResult('Sold to Nobody for $500',context(),binding).issues.owners);
  assert.ok(parseResult('Sold to Alpha and Bravo for $500',context(),binding).issues.shares);
  assert.ok(parseResult('Sold to Alpha for five-ish',context(),binding).issues.amount);
  assert.ok(parseResult('Bills sold to Alpha for $500',context(),binding).issues.lot);
  const c=context();c.consortia[1].aliases=['Alpha'];assert.ok(parseResult('Sold to Alpha for $500',c,binding).issues.owners);
  assert.ok(parseResult('Not sold to Alpha for $500',context(),binding).issues.announcement);
  assert.equal(parseResult('Going once, twice, $500',context(),binding),null);
});
test('partials cannot sell; repeated final callbacks cannot create duplicate drafts',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha for $500',{final:false}));assert.equal(f.live.data.drafts.length,0);
  const event=speech('Sold to Alpha for $500');f.live.ingest(event);f.live.ingest({...event,id:'another-callback-id'});
  assert.equal(f.live.data.drafts.length,1);assert.equal(f.live.data.drafts[0].status,'pending');
});
test('final fragments combine for the same speaker without losing original nomination binding',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha'));assert.equal(f.live.data.drafts[0].status,'review');
  f.live.ingest(speech('for $500',{start:5}));assert.equal(f.live.data.drafts.length,1);assert.equal(f.live.data.drafts[0].status,'pending');
});
test('late speech retains old lot and requires review after a nomination change',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);const c=context();c.lots[0].status='sold';c.lots[1].status='bidding';c.lots[1].nominationId='nom-2';c.currentLotId=11;f.setContext(c);await f.live.sync();
  f.live.ingest(speech('Sold to Alpha for $500'));const d=f.live.data.drafts[0];assert.equal(d.lotId,10);assert.equal(d.status,'review');assert.ok(d.issues.lot);
});
test('no nomination, missing timestamps, stale context and boundary speech never auto-submit',async()=>{
  const f=fixture();await f.live.sync();f.setTime(101000);f.live.ingest(speech('Sold to Alpha for $500',{start:1}));assert.equal(f.live.data.drafts[0].status,'review');
  const g=fixture();await g.live.sync();g.setTime(110000);g.live.ingest(speech('Sold to Alpha for $500'));assert.equal(g.live.data.drafts[0].status,'review');
  const h=fixture();await h.live.sync();h.setTime(105000);h.live.ingest(speech('Sold to Alpha for $500',{captureStartedAt:undefined}));assert.equal(h.live.data.drafts[0].status,'review');
  const c=context();c.currentLotId=null;assert.ok(validateDraft({lotId:10,nominationId:'nom-1',totalCents:50000,allocations:[{consortiumId:1,basisPoints:10000}]},c).lot);
});
test('lost acknowledgment survives restart with identical immutable request ID',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha for $500'));
  const sent=[];f.setSend(async r=>{sent.push(r);throw new Error('lost response');});await f.live.flush();assert.equal(f.live.data.drafts[0].status,'pending');
  assert.throws(()=>f.live.correct({id:f.live.data.drafts[0].id}),/already awaiting/);
  const restarted=new LiveAuction({file:f.file,bridge:f.bridge,now:f.getTime});f.setSend(async r=>{sent.push(r);return{idempotencyKey:r.idempotencyKey,saleId:50};});await restarted.flush();
  assert.deepEqual(sent[0],sent[1]);assert.equal(restarted.data.drafts[0].status,'submitted');
});
test('deterministic rejection becomes editable review; invalid percentages cannot submit',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha for $500'));
  f.setSend(async()=>{throw Object.assign(new Error('Conflict'),{status:409});});await f.live.flush();const d=f.live.data.drafts[0];assert.equal(d.status,'review');
  const edit={id:d.id,expectedRevision:d.revision,lotId:10,totalCents:55000,allocations:[{consortiumId:1,basisPoints:9999}]};assert.throws(()=>f.live.correct(edit),/100%/);
  f.live.correct({...edit,allocations:[{consortiumId:1,basisPoints:10000}]});assert.equal(d.status,'pending');assert.equal(d.totalCents,55000);
});
test('unresolved results cannot move to another auction; no acknowledgment means no saved status',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha for $500'));
  f.setSend(async()=>({}));await f.live.flush();assert.equal(f.live.data.drafts[0].status,'pending');
  f.bridge.data.pairing.id='session-2';await f.live.sync();assert.equal(f.live.data.sessionId,'session-1');assert.match(f.live.error,/previous auction/);
});
test('beginning manual review prevents subsequent fragments or announcements from auto-submitting',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha'));
  const d=f.live.data.drafts[0];f.live.beginReview({id:d.id,expectedRevision:d.revision,lotId:10});
  f.live.ingest(speech('for $500',{start:5}));assert.equal(d.status,'review');assert.equal(d.totalCents,null);
  f.live.ingest(speech('Sold to Alpha for $500',{start:5}));assert.ok(f.live.data.drafts.every(d=>d.status==='review'));
});

test('auction history survives A to B to A and restart without mixing origins',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);
  f.live.ingest(speech('Sold to Alpha for $500'));await f.live.flush();
  const keyA=f.live.data.auctionKey;
  f.bridge.data.pairing={id:'session-B',origin:'https://thecalcutta.app',auction:{id:2}};
  f.setContext({...context(),id:2});await f.live.sync();
  assert.equal(f.live.data.drafts.length,0);assert.equal(f.live.data.transcript.length,0);
  assert.notEqual(f.live.data.auctionKey,keyA);
  f.bridge.data.pairing={id:'session-A2',origin:'https://thecalcutta.app',auction:{id:1}};
  f.setContext(context());await f.live.sync();
  assert.equal(f.live.data.auctionKey,keyA);assert.equal(f.live.data.drafts[0].status,'submitted');
  assert.equal(f.live.data.transcript.length,1);assert.equal(f.live.data.sessionId,'session-A2');
  const restarted=new LiveAuction({file:f.file,bridge:f.bridge,now:f.getTime});await restarted.sync();
  assert.equal(restarted.data.drafts.length,1);
  f.bridge.data.pairing={id:'session-other-site',origin:'https://www.thecalcutta.app',auction:{id:1}};
  await restarted.sync();assert.equal(restarted.data.drafts.length,0);
});

test('restart preserves unsent review and reconnect observation cannot reuse old speech timing',async()=>{
  const f=fixture();await f.live.sync();f.setTime(105000);
  f.live.ingest(speech('Sold to unknown for $500'));
  const restarted=new LiveAuction({file:f.file,bridge:f.bridge,now:f.getTime});await restarted.sync();
  assert.equal(restarted.data.drafts[0].status,'review');
  restarted.ingest(speech('Sold to Alpha for $500',{uploadId:'late-upload'}));
  assert.equal(restarted.data.drafts[1].status,'review');
  assert.ok(restarted.data.drafts[1].issues.lot);
});

test('context from a different auction cannot change saved state or enable recording',async()=>{
  const f=fixture();await f.live.sync();const key=f.live.data.auctionKey;
  f.setContext({...context(),id:999});await f.live.sync();
  assert.equal(f.live.ready(),false);assert.equal(f.live.data.auctionKey,key);
  assert.match(f.live.error,/different auction/);
});
