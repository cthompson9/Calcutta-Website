import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startBackend} from '../server/main.mjs';

test('paired local API pulls context, captures a review and submits the corrected result',async t=>{
  const id='11111111-1111-4111-8111-111111111111', nominationId='22222222-2222-4222-8222-222222222222';
  const context={protocolVersion:2,id:1,currentLotId:10,lots:[{id:10,displayName:'Chiefs',status:'bidding',nominationId}],consortia:[{id:1,displayName:'Alpha',active:1}],sales:[]};
  const sent=[];let targetAuction=1;
  const app=await startBackend({dataDir:mkdtempSync(join(tmpdir(),'listener-http-live-')),port:0,env:{RECALL_API_KEY:'fake-test-key'},fetcher:async(url,options)=>{
    const body=options.body?JSON.parse(options.body):null;
    const value=url.endsWith('/preview')?{auction:{id:targetAuction,name:'Test auction'}}:url.endsWith('/pair')?{id,token:'x'.repeat(43),expiresAt:'2099-01-01',auction:{id:1,name:'Test auction'}}
      :url.endsWith('/context')?context
      :url.endsWith('/results')?(sent.push(body),{saleId:1,idempotencyKey:body.idempotencyKey})
      :url.endsWith('/events')?{acceptedIds:body.events.map(e=>e.id)}:{ok:true};
    return new Response(JSON.stringify(value),{status:200});
  }});
  t.after(()=>{app.server.closeAllConnections();app.server.close();});
  const call=(path,body,auth=true)=>fetch(app.connection.url+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${app.connection.token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('/api/live',undefined,false)).status,401);
  assert.equal((await call('/api/website/pair',{url:`calcutta-listener://connect#origin=${encodeURIComponent('https://thecalcutta.app')}&ticket=${'t'.repeat(43)}`})).status,200);
  assert.equal((await (await call('/api/live')).json()).ready,true);
  const event={id:'event-1',websiteSessionId:id,sessionId:'local-1',uploadId:'upload-1',event:{event:'transcript.data',data:{data:{words:[{text:'Sold to unknown for $500'}]}}}};
  assert.equal((await call('/api/transcript',event)).status,200);
  const draft=(await (await call('/api/live')).json()).drafts[0];assert.equal(draft.status,'review');assert.ok(draft.issues.owners);
  const launch={url:`calcutta-listener://connect#origin=${encodeURIComponent('https://thecalcutta.app')}&ticket=${'t'.repeat(43)}`};
  assert.equal((await call('/api/website/pair',launch)).status,200);
  assert.equal((await (await call('/api/live')).json()).drafts[0].id,draft.id);
  targetAuction=2;
  const blocked=await call('/api/website/pair',launch);
  assert.notEqual(blocked.status,200);assert.match((await blocked.json()).error,/before switching/);
  assert.equal((await (await call('/api/live')).json()).drafts[0].id,draft.id);
  targetAuction=1;
  assert.equal((await call('/api/live/result',{id:draft.id,expectedRevision:draft.revision,lotId:10,totalCents:50000,allocations:[{consortiumId:1,basisPoints:10000}]})).status,200);
  // Wait on the actual single-flight operation, without making another sale request.
  while(app.live.sending)await new Promise(r=>setTimeout(r,5));
  assert.equal(sent.length,1);assert.equal(app.live.data.drafts[0].status,'submitted');
  assert.equal(sent[0].lotId,10);assert.equal(sent[0].nominationId,nominationId);
  const state=JSON.stringify(await (await call('/api/live')).json());assert.ok(!state.includes('fake-test-key'));assert.ok(!state.includes('x'.repeat(43)));
});
