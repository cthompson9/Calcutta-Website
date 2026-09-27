import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');

test('minimal UI highlights current lot and lets commissioner correct a red review inline',async t=>{
  const dom=new JSDOM(html,{url:'http://127.0.0.1:43127',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window, d=w.document, requests=[];let statusHandler;
  const state={ready:true,pending:0,error:'',context:{currentLotId:10,lots:[{id:10,displayName:'Chiefs',status:'bidding',nominationId:'n-1'}],consortia:[{id:1,displayName:'Alpha',active:1}],sales:[]},transcript:[{text:'Sold to maybe Alpha for $500',final:true}],drafts:[{id:'draft-1',revision:1,lotId:10,totalCents:50000,allocations:[{consortiumId:null,heardName:'Maybe Alpha',basisPoints:10000}],status:'review',issues:{owners:'Unknown winner'}}]};
  w.capture={status:async()=>({recording:true,status:'recording'}),onStatus:fn=>statusHandler=fn,onWebsite:()=>{},start:async()=>({recording:true}),stop:async()=>({recording:false}),permissions:()=>{}};
  w.fetch=async(url,options)=>{if(options.body)requests.push({url,body:JSON.parse(options.body)});return{ok:true,json:async()=>url==='/api/website'?{auction:{name:'Test auction'}}:url==='/api/live/review'?{...structuredClone(state.drafts[0]),revision:2}:structuredClone(state)};};
  w.eval(source);await new Promise(r=>setTimeout(r,10));
  assert.equal(d.getElementById('current').textContent,'Chiefs');assert.equal(d.querySelectorAll('.active-lot').length,1);
  assert.match(d.querySelector('.needs-review').textContent,/Needs a look/);
  assert.ok(d.getElementById('transcript').compareDocumentPosition(d.getElementById('results')) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(!d.body.textContent.includes('Auction so far'));assert.equal(d.getElementById('practice'),null);
  [...d.querySelectorAll('button')].find(b=>b.textContent==='Correct & submit').click();
  await new Promise(r=>setTimeout(r,10));
  d.querySelector('select[aria-label="Winning consortium"]').value='1';
  [...d.querySelectorAll('button')].find(b=>b.textContent==='Submit').click();await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(requests.find(r=>r.url==='/api/live/result').body,{id:'draft-1',expectedRevision:2,lotId:10,totalCents:50000,allocations:[{consortiumId:1,basisPoints:10000}]});
  statusHandler({recording:false,status:'stopped'});assert.equal(d.getElementById('current').textContent,'');
});
