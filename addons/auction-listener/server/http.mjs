import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHmac } from 'node:crypto';
const webRoot=new URL('../web/',import.meta.url);
const equal=(a,b)=>typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req) {
  const chunks=[]; let size=0;
  for await (const c of req) { size+=c.length; if(size>262144) throw new Error('Request too large.'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
export function verifiedWebhook(raw, headers, secret, now=Date.now()) {
  if (!secret) return false;
  const stamp=headers['webhook-timestamp'], id=headers['webhook-id'];
  if (typeof stamp!=='string' || typeof id!=='string' || Math.abs(now/1000-Number(stamp))>300 || !/^\d+$/.test(stamp)) return false;
  const key=Buffer.from(secret.replace(/^whsec_/,''),'base64');
  const sig=createHmac('sha256',key).update(`${id}.${stamp}.${raw}`).digest('base64');
  return String(headers['webhook-signature']??'').split(' ').some(v=>v.startsWith('v1,') && equal(v.slice(3),sig));
}
export function createAuctionServer({store,recall,token,bridge}) {
  let creating=false;
  const server=createServer(async(req,res)=>{
    const origin=`http://${req.headers.host}`;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host??'') || (req.headers.origin && req.headers.origin!==origin)) {json(403,{error:'Only the local auction app can access this server.'});return;}
    const path=new URL(req.url,origin).pathname;
    try {
      if (req.method==='GET' && ['/','/app.js','/style.css'].includes(path)) {
        res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');
        res.end(readFileSync(fileURLToPath(new URL(path==='/'?'index.html':path.slice(1),webRoot))));return;
      }
      if (req.method==='POST' && path==='/api/recall/webhook') {
        const raw=await body(req);
        if(!verifiedWebhook(raw,req.headers,recall.config.webhookSecret)){json(401,{error:'Unverified webhook.'});return;}
        store.applyLifecycle(JSON.parse(raw));json(200,{ok:true});return;
      }
      if (req.method==='POST' && path==='/api/auth') {
        const input=JSON.parse(await body(req));
        if(!equal(input.token,token)){json(401,{error:'Open this board from the launcher.'});return;}
        res.setHeader('Set-Cookie',`calcutta_local=${token}; HttpOnly; SameSite=Strict; Path=/`);
        json(200,{ok:true});return;
      }
      const bearer=req.headers.authorization?.replace(/^Bearer /,'');
      const cookie=/\bcalcutta_local=([^;]+)/.exec(req.headers.cookie??'')?.[1];
      if (!equal(bearer,token) && !equal(cookie,token)){json(401,{error:'Open the board from the Calcutta launcher.'});return;}
      if (req.method==='GET' && path==='/api/state') {json(200,{...store.snapshot(),recallConfigured:!!recall.config.apiKey,apiUrl:recall.config.apiUrl});return;}
      if (req.method==='GET' && path==='/api/website') {json(200,bridge?.status()??{connected:false});return;}
      if (req.method==='GET' && path==='/api/events') {
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});
        const send=s=>res.write(`data: ${JSON.stringify(s)}\n\n`);
        send(store.snapshot());store.listeners.add(send);
        const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);
        req.on('close',()=>{clearInterval(heartbeat);store.listeners.delete(send);});return;
      }
      if (req.method==='GET' && path==='/api/export') {
        res.setHeader('Content-Disposition','attachment; filename="calcutta-rehearsal.json"');
        json(200,store.snapshot());return;
      }
      if (req.method==='POST') {
        const input=JSON.parse((await body(req))||'{}');
        if(path==='/api/website/pair') {
          if(!bridge) throw new Error('Website connection is unavailable.');
          if(creating || store.state.uploads.some(u=>['ready','recording_started'].includes(u.status))) throw new Error('Stop recording before connecting to an auction.');
          json(200,await bridge.pair(input.url));return;
        }
        if(path==='/api/website/tick') {
          await bridge?.flush();await bridge?.heartbeat(!!input.recording);
          json(200,bridge?.status()??{connected:false});return;
        }
        if(path==='/api/session') {
          if(creating || store.state.uploads.some(u=>['ready','recording_started'].includes(u.status))) throw new Error('Stop recording before starting a new rehearsal.');
          store.newSession(input.lots);json(200,store.snapshot());return;
        }
        if(path==='/api/result') {store.edit(input);json(200,store.snapshot());return;}
        if(path==='/api/transcript') {
          if(input.websiteSessionId) {
            if(input.websiteSessionId!==bridge?.data.pairing?.id) throw new Error('Transcript belongs to a different website session.');
            bridge.enqueue({...input,receivedAt:new Date().toISOString()});void bridge.flush();
          } else store.ingest({...input,source:'recall'});
          json(200,{ok:true});return;
        }
        if(path==='/api/rehearse') {
          if(typeof input.text!=='string' || input.text.length>20000) throw new Error('Enter a short auction announcement.');
          store.ingest({sessionId:store.state.id,uploadId:'typed-rehearsal',source:'typed rehearsal',event:{event:'transcript.data',data:{data:{participant:{id:0,name:'Typed rehearsal'},words:[{text:input.text,start_timestamp:{relative:Date.now()/1000}}]}}}});
          json(200,store.snapshot());return;
        }
        if(path==='/api/uploads') {
          if(bridge?.data.pairing && !bridge.status().connected) throw new Error('Open the listener from the Auction tab to reconnect before recording.');
          if(creating || store.state.uploads.some(u=>['ready','recording_started'].includes(u.status))) throw new Error('A recording is already starting or active.');
          if(!recall.config.apiKey) throw new Error('Recall API key has not been configured.');
          creating=true;const sessionId=store.state.id;const intent=store.uploadIntent();
          try {
            const u=await recall.createUpload(sessionId);
            if(typeof u.id!=='string' || typeof u.upload_token!=='string') throw new Error('Recall returned an incomplete recording response.');
            store.uploadCreated(intent,u.id);
            json(201,{id:u.id,uploadToken:u.upload_token,sessionId,apiUrl:recall.config.apiUrl,websiteSessionId:bridge?.data.pairing?.id});
          } catch(error) {store.uploadStatus(intent,'creation_unconfirmed');throw error;}
          finally {creating=false;}
          return;
        }
        if(path==='/api/upload-status') {
          if(!['recording_started','recording_ended','failed'].includes(input.status)) throw new Error('Invalid recording status.');
          store.uploadStatus(input.id,input.status);json(200,{ok:true});return;
        }
        if(path==='/api/reconcile') {
          if(!store.state.uploads.some(u=>u.id===input.id)) throw new Error('Unknown recording.');
          const u=await recall.getUpload(input.id);
          const status=u.status?.code;
          if(['complete','failed','recording_started','recording_ended','uploading'].includes(status)) store.uploadStatus(u.id,status,u.recording_id);
          json(200,{status:status??'unknown'});return;
        }
      }
      json(404,{error:'Not found.'});
    } catch(error) {json(400,{error:error instanceof SyntaxError?'Invalid request.':error.message||'Request failed.'});}
  });
  server.requestTimeout=30000;
  return server;
}
