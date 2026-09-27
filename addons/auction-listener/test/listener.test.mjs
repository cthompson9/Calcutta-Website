import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { AuctionStore } from '../server/store.mjs';
import { priceCents, interpret, parseOwners } from '../server/interpreter.mjs';
import { readRecallConfig, RecallClient } from '../server/recall.mjs';
import { verifiedWebhook } from '../server/http.mjs';
import { startBackend } from '../server/main.mjs';
const require=createRequire(import.meta.url);
const {CaptureController,transcriptPayload}=require('../desktop/controller.cjs');
const payload=(text,t=0,kind='transcript.data')=>({event:kind,data:{data:{words:[{text,start_timestamp:{relative:t},end_timestamp:{relative:t+1}}],participant:{id:1,name:'Host'}}}});
function fixture(file){const store=new AuctionStore(file);store.uploadCreated(store.uploadIntent(),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');return store;}
function say(store,text,t=0,kind){store.ingest({sessionId:store.state.id,uploadId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',event:payload(text,t,kind)});}

test('money parsing accepts explicit amounts, rejects ambiguous shorthand and appended corrections',()=>{
  for(const [text,amount] of [['$1,250.50',125050],['five hundred dollars',50000],['one thousand two hundred and fifty',125000],['twenty-five',2500]]) assert.equal(priceCents(text),amount,text);
  for(const text of ['five fifty','one two','twenty ten','500 actually 600','-100','0','1000001','two hundred hundred','5,00'])assert.equal(priceCents(text),null,text);
});
test('unknown owners and explicit equal split; omitted shares are unresolved',()=>{
  assert.deepEqual(parseOwners('Craig and Dave, fifty-fifty'),[{name:'Craig',basisPoints:5000},{name:'Dave',basisPoints:5000}]);
  assert.equal(parseOwners('New Person')[0].basisPoints,10000);
  assert.equal(parseOwners('Craig and Dave')[0].basisPoints,null);
  assert.equal(parseOwners('Craig and Craig'),null);
});
test('known lot nominations work out of order; countdown does not sell',()=>{
  const s=fixture();say(s,'Next up, Bills.',0);say(s,'Once, twice.',2);assert.equal(s.state.sales.length,0);
  say(s,'Sold to A New Buyer for five hundred dollars.',4);
  assert.equal(s.state.sales[0].lotId,'4');assert.equal(s.state.sales[0].priceCents,50000);
  say(s,'Next up, Chiefs.',6);assert.equal(s.state.currentLotId,'16');
});
test('final callback is idempotent; partial never creates a result',()=>{
  const s=fixture();say(s,'Chiefs sold to Craig for $500',0,'transcript.partial_data');assert.equal(s.state.sales.length,0);
  say(s,'Chiefs sold to Craig for $500',0);say(s,'Chiefs sold to Craig for $500',0);say(s,'Chiefs sold to Craig for $500',2);assert.equal(s.state.sales.length,1);
});
test('a sold lot cannot be changed by speech, including after commissioner edit',()=>{
  const s=fixture();say(s,'Chiefs sold to Craig for $500');const sale=s.state.sales[0];
  s.edit({saleId:sale.id,lotId:sale.lotId,priceCents:60000,owners:[{name:'Dave',basisPoints:10000}],expectedRevision:1});
  say(s,'Chiefs sold to Craig for $500',2);assert.equal(s.state.sales[0].priceCents,60000);assert.equal(s.state.reviews.length,1);assert.equal(s.state.history.length,2);
});
test('negation, conditional speech, unknown and ambiguous lots never create sales',()=>{
  const s=fixture();
  for(const text of ['Chiefs not sold to Craig for $500','If Chiefs sold to Craig for $500','Maybe Chiefs sold to Craig for $500','New York sold to Craig for $500','Unknown sold to Craig for $500']) assert.notEqual(interpret(text,s.state).kind,'sale');
});
test('sale can span consecutive finalized transcript fragments from same speaker',()=>{
  const s=fixture();say(s,'Next up Chiefs',0);say(s,'Sold to Craig for',2);say(s,'five hundred dollars',4);assert.equal(s.state.sales[0].priceCents,50000);
});
test('incomplete sale remains visible and cannot swallow the next nomination',()=>{
  const s=fixture();say(s,'Chiefs sold to Craig',0);assert.ok(s.snapshot().pendingAnnouncement);
  say(s,'Next up we have the Bills',2);assert.equal(s.state.currentLotId,'4');assert.equal(s.state.sales.length,0);assert.equal(s.state.reviews.length,1);
});
test('multiple nomination commands and late transcripts are handled conservatively',()=>{
  const s=fixture();say(s,'Next up Chiefs. Sold to Craig for $500. Next up Bills.',10);assert.equal(s.state.sales.length,1);assert.equal(s.state.currentLotId,'4');
  say(s,'Sold to Dave for $200',5);assert.equal(s.state.sales.length,1);assert.equal(s.state.reviews.length,1);
});
test('split shares require exact totals; stale commissioner changes rejected',()=>{
  const s=fixture();say(s,'Chiefs sold to Craig and Dave for $500');const r=s.state.sales[0];assert.equal(r.needsShares,true);
  assert.throws(()=>s.edit({saleId:r.id,lotId:r.lotId,priceCents:50000,expectedRevision:1,owners:[{name:'Craig',basisPoints:4999},{name:'Dave',basisPoints:5000}]}),/100%/);
  s.edit({saleId:r.id,lotId:r.lotId,priceCents:50000,expectedRevision:1,owners:[{name:'Craig',basisPoints:5000},{name:'Dave',basisPoints:5000}]});
  assert.equal(s.state.sales[0].needsShares,false);
  assert.throws(()=>s.edit({saleId:r.id,lotId:r.lotId,priceCents:50000,expectedRevision:1,owners:[{name:'Craig',basisPoints:10000}]}),/changed/);
});
test('results, deduplication, and correction history survive process restart',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'calcutta-test-')),'state.json');
  const s=fixture(file);say(s,'Chiefs sold to Craig for $500');const resumed=new AuctionStore(file);say(resumed,'Chiefs sold to Craig for $500');assert.equal(resumed.state.sales.length,1);assert.equal(resumed.state.history.length,1);
  resumed.newSession();assert.equal(resumed.state.sales.length,0);assert.ok(readFileSync(`${file}.${s.state.id}.archive.json`,'utf8').includes('Craig'));
});
test('both SDK terminal events persist, unrelated upload cannot modify state',()=>{
  for(const status of ['complete','failed']) {
    const s=fixture();s.applyLifecycle({event:`sdk_upload.${status}`,data:{sdk_upload:{id:s.state.uploads[0].id},recording:{id:'recording-1'}}});assert.equal(s.state.uploads[0].status,status);
  }
  const s=fixture();assert.throws(()=>s.applyLifecycle({event:'sdk_upload.complete',data:{sdk_upload:{id:'other'}}}),/Unknown/);
});
test('Recall config and API client keep keys server-side and request live audio-only transcription',async()=>{
  const config=readRecallConfig({RECALL_REGION:'us-west-2',RECALL_API_KEY:'fake-key'});let request;
  const recall=new RecallClient(config,async(url,options)=>{request={url,options};return new Response(JSON.stringify({id:'upload-1',upload_token:'token-only'}),{status:201});});
  await recall.createUpload('session-1');assert.equal(request.options.headers.Authorization,'Token fake-key');assert.equal(request.url,'https://us-west-2.recall.ai/api/v1/sdk_upload/');
  const body=JSON.parse(request.options.body);assert.equal(body.recording_config.video_mixed_mp4,null);assert.equal(body.recording_config.transcript.provider.recallai_streaming.mode,'prioritize_low_latency');assert.equal(body.recording_config.realtime_endpoints[0].type,'desktop_sdk_callback');
  assert.throws(()=>readRecallConfig({RECALL_REGION:'attacker.example'}));
});
test('webhooks require a valid signature over the original bytes and fresh timestamp',()=>{
  const secret=`whsec_${Buffer.from('fake-secret').toString('base64')}`;const raw='{"event":"sdk_upload.complete"}';const stamp=String(Math.floor(Date.now()/1000)),id='message-id';const signature=createHmac('sha256','fake-secret').update(`${id}.${stamp}.${raw}`).digest('base64');
  const headers={'webhook-id':id,'webhook-timestamp':stamp,'webhook-signature':`v1,${signature}`};assert.equal(verifiedWebhook(raw,headers,secret),true);assert.equal(verifiedWebhook(`${raw} `,headers,secret),false);assert.equal(verifiedWebhook(raw,headers,secret,Date.now()+600000),false);
});
test('HTTP boundaries reject unauthorized/cross-origin writes and never expose the Recall key',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'calcutta-http-'));
  const app=await startBackend({dataDir,port:0,env:{RECALL_API_KEY:'never-return-this-key'},fetcher:async()=>new Response(JSON.stringify({id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',upload_token:'upload-token'}),{status:201})});
  t.after(()=>{app.server.closeAllConnections();app.server.close();});
  const call=(path,data,auth=true,extra={})=>fetch(app.connection.url+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${app.connection.token}`} :{}),...extra},...(data?{body:JSON.stringify(data)}:{})});
  assert.equal((await call('/api/rehearse',{text:'Chiefs sold to Craig for $500'},false)).status,401);
  assert.equal((await call('/api/rehearse',{text:'Chiefs sold to Craig for $500'},true,{Origin:'https://example.com'})).status,403);
  assert.equal((await call('/api/uploads',{})).status,400,'unpaired listener must not create a recording');
  const state=await (await call('/api/state')).json();assert.equal(state.sales.length,0);assert.ok(!JSON.stringify(state).includes('never-return'));assert.ok(!JSON.stringify(state).includes('upload-token'));
});
function fakeCapture({platform='win32',denied=false}={}) {
  const events={},calls=[],sdk={addEventListener:(n,fn)=>events[n]=fn,init:async()=>{},requestPermission:async p=>events['permission-status']({permission:p,status:denied?'denied':'granted'}),prepareDesktopAudioRecording:async()=> 'window-1',startRecording:async args=>calls.push(args),stopRecording:async()=>{}};
  const requests=[],settings=[];
  const controller=new CaptureController({sdk,apiUrl:'https://us-west-2.recall.ai',platform,api:async(path,body)=>{requests.push({path,body});return{id:'upload-1',sessionId:'session-1',uploadToken:'upload-token'};},openSettings:async url=>settings.push(url)});
  return{controller,events,calls,requests,settings};
}
test('desktop starts via backend token exchange and forwards actual callback to ingestion',async()=>{
  const f=fakeCapture();await f.controller.start();assert.deepEqual(f.calls[0],{windowId:'window-1',uploadToken:'upload-token'});
  f.events['realtime-event']({window:{id:'window-1'},...payload('Chiefs sold to Craig for $500')});await new Promise(r=>setTimeout(r,10));
  assert.ok(f.requests.some(r=>r.path==='/api/transcript'));await f.controller.stop();assert.equal(f.controller.active,null);assert.ok(f.requests.some(r=>r.body?.status==='recording_ended'));
});
test('denied permission opens a concrete OS settings pane; no upload created',async()=>{
  const f=fakeCapture({platform:'darwin',denied:true});await f.controller.start();assert.equal(f.controller.state.status,'permission');assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);await f.controller.fixPermission(f.controller.state.permission);assert.match(f.settings[0],/^x-apple.systempreferences:/);
});
test('callback normalizer handles SDK envelope and rejects malformed data',()=>{
  const base=payload('Hello');assert.deepEqual(transcriptPayload(base),base);assert.deepEqual(transcriptPayload({event:base.event,data:{data:base.data}}),base);assert.throws(()=>transcriptPayload({event:'transcript.data',data:{}}));
});
test('desktop packaging excludes backend secrets and keeps native helpers unpacked',()=>{
  const packaging=readFileSync(new URL('../desktop/package.mjs',import.meta.url),'utf8');assert.match(packaging,/asar:false/);assert.match(packaging,/NSMicrophoneUsageDescription/);assert.match(packaging,/NSAudioCaptureUsageDescription/);
  const desktop=readFileSync(new URL('../desktop/main.cjs',import.meta.url),'utf8');assert.ok(!desktop.includes('backend-config.json'));assert.ok(!desktop.includes('RECALL_API_KEY'));
});
