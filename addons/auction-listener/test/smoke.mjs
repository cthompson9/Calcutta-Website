import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {startBackend} from '../server/main.mjs';
const app=await startBackend({dataDir:mkdtempSync(join(tmpdir(),'calcutta-smoke-')),port:0,env:{}});
try {
  const html=await fetch(app.connection.url).then(r=>r.text());assert.ok(html.includes('Start listening'));
  const headers={Authorization:`Bearer ${app.connection.token}`,'Content-Type':'application/json'};
  for(const text of ['Next up Chiefs','Sold to Craig and Dave, fifty-fifty, for five hundred dollars','Next up Bills']){
    const r=await fetch(`${app.connection.url}/api/rehearse`,{method:'POST',headers,body:JSON.stringify({text})});assert.equal(r.status,200);
  }
  const state=await fetch(`${app.connection.url}/api/state`,{headers}).then(r=>r.json());assert.equal(state.sales.length,1);assert.equal(state.sales[0].owners.length,2);assert.equal(state.currentLotId,'4');
  console.log('PASS: real local HTTP server, page, nomination, shared sale, and next nomination. No Recall recording or production write performed.');
}finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
