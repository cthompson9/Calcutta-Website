import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {WebsiteBridge} from '../server/bridge.mjs';
const {parseLaunchLink}=createRequire(import.meta.url)('../server/launch-link.cjs');
const origin='https://thecalcutta.app';
const link=`calcutta-listener://connect#origin=${encodeURIComponent(origin)}&ticket=${'a'.repeat(43)}`;
const session={id:'session-1',token:'b'.repeat(43),expiresAt:'2099-01-01T00:00:00Z',auction:{id:'42',name:'Test auction'}};
function fixture(fetcher){return new WebsiteBridge({file:join(mkdtempSync(join(tmpdir(),'calcutta-bridge-')),'bridge.json'),fetcher});}
const ok=value=>({ok:true,json:async()=>value});
test('launch link accepts only fixed HTTPS origins and exact ticket shape',()=>{
  assert.equal(parseLaunchLink(link).origin,origin);
  for(const bad of [link.replace('thecalcutta.app','evil.example'),link.replace('https%3A','http%3A'),link+'&ticket='+ 'c'.repeat(43),link.replace('connect#','connect/extra#'),link.replace('connect#','connect?ticket=secret#'),link.replace('a'.repeat(43),'short')]){
    assert.throws(()=>parseLaunchLink(bad));
  }
});
test('pairing stores only public status in renderer response and forbids redirects',async()=>{
  let request;
  const bridge=fixture(async(url,options)=>{request={url,...options};return ok(session);});
  const status=await bridge.pair(link);
  assert.equal(status.auction.name,'Test auction');assert.equal(status.token,undefined);
  assert.equal(request.redirect,'error');assert.equal(request.url,origin+'/api/listener/pair');
  assert.equal(request.headers.Authorization,undefined);
});
test('uncertain redemption retries with same identity across restart',async()=>{
  const sent=[];
  const bridge=fixture(async(_url,options)=>{sent.push(JSON.parse(options.body));throw new Error('offline');});
  await assert.rejects(bridge.pair(link));
  const restarted=new WebsiteBridge({file:bridge.file,fetcher:async(_url,options)=>{sent.push(JSON.parse(options.body));return ok(session);}});
  await restarted.pair(link);
  assert.equal(sent[0].redemptionId,sent[1].redemptionId);
});
test('outbox survives lost acknowledgment and only removes explicitly accepted IDs',async()=>{
  let online=false;
  const bridge=fixture(async url=>url.endsWith('/pair')?ok(session):online?ok({acceptedIds:['event-1']}):ok({acceptedIds:[]}));
  await bridge.pair(link);bridge.enqueue({id:'event-1',event:{event:'transcript.data'}});bridge.enqueue({id:'event-1'});
  await bridge.flush();assert.equal(bridge.status().pending,1);
  await assert.rejects(bridge.pair(link),/pending/);
  const restarted=new WebsiteBridge({file:bridge.file,fetcher:bridge.fetcher});online=true;
  await restarted.flush();assert.equal(restarted.status().pending,0);
});
test('expired sessions are visible and disallowed origins never receive credentials',async()=>{
  const bridge=fixture(async()=>{throw new Error('must not send');});
  bridge.data.pairing={...session,origin:'https://evil.example',expiresAt:'2000-01-01'};
  assert.equal(bridge.status().connected,false);
  await bridge.heartbeat();assert.equal(bridge.message,'Website is not allowed.');
});
