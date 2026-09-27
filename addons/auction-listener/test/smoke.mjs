import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {startBackend} from '../server/main.mjs';
const app=await startBackend({dataDir:mkdtempSync(join(tmpdir(),'calcutta-smoke-')),port:0,env:{}});
try {
  const html=await fetch(app.connection.url).then(r=>r.text());assert.ok(html.includes('Start listening'));
  const headers={Authorization:`Bearer ${app.connection.token}`,'Content-Type':'application/json'};
  assert.ok(!html.includes('AUCTION SO FAR'));
  const state=await fetch(`${app.connection.url}/api/live`,{headers}).then(r=>r.json());assert.equal(state.ready,false);assert.equal(state.context,null);
  const start=await fetch(`${app.connection.url}/api/uploads`,{method:'POST',headers,body:'{}'});assert.equal(start.status,400);
  console.log('PASS: local page and disconnected recording guard. No recording or production write performed.');
}finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
