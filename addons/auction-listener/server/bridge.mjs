import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const {parseLaunchLink, DEFAULT_ORIGINS} = createRequire(import.meta.url)('./launch-link.cjs');

// Durable outbound-only bridge. No website is allowed to call the loopback server.
export class WebsiteBridge {
  constructor({file, allowedOrigins=DEFAULT_ORIGINS, fetcher=fetch, now=Date.now}) {
    Object.assign(this, {file, allowedOrigins, fetcher, now});
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {pairing:null, queue:[]};
    this.message = ''; this.sending = false;
  }
  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), {mode:0o600});
    renameSync(`${this.file}.tmp`, this.file);
  }
  status() {
    const p = this.data.pairing;
    return {connected:!!p && Date.parse(p.expiresAt)>this.now(), auction:p?.auction??null,
      origin:p?.origin??null, pending:this.data.queue.length, message:this.message};
  }
  async request(origin, route, body, token) {
    if (!this.allowedOrigins.includes(origin)) throw new Error('Website is not allowed.');
    const response = await this.fetcher(`${origin}${route}`, {method:'POST',redirect:'error',
      headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
      body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error(response.status===401 || response.status===410
      ? 'Connection expired. Open the listener again from the Auction tab.' : 'Website unavailable. Saved events will retry.');
    return response.json();
  }
  async pair(raw) {
    if (this.data.queue.length) throw new Error('Deliver pending transcripts before changing the connected auction.');
    const {origin,ticket} = parseLaunchLink(raw,this.allowedOrigins);
    // Persist one redemption identity so a lost HTTP response can safely be retried.
    if(this.data.pending?.ticket !== ticket) {
      this.data.pending={origin,ticket,redemptionId:randomUUID()}; this.save();
    }
    const result=await this.request(origin,'/api/listener/pair',this.data.pending);
    if(!/^[A-Za-z0-9_-]{43}$/.test(result.token??'') || !/^[A-Za-z0-9_-]{1,80}$/.test(result.id??'') ||
      !result.auction || typeof result.auction.name!=='string' || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt)<=this.now()) {
      throw new Error('Website returned an invalid listener session.');
    }
    this.data.pairing={origin,id:result.id,token:result.token,expiresAt:result.expiresAt,auction:result.auction};
    delete this.data.pending; this.message='Connected. Click Start listening when ready.'; this.save();
    return this.status();
  }
  enqueue(payload) {
    const p=this.data.pairing;
    if(!p) return;
    if(this.data.queue.some(item=>item.event.id===payload.id)) return;
    if(this.data.queue.length>=10000) throw new Error('Website delivery queue is full. Stop recording and restore the connection.');
    this.data.queue.push({sessionId:p.id,event:payload}); this.save();
  }
  async flush() {
    if(this.sending || !this.data.pairing) return;
    this.sending=true;
    try {
      const p=this.data.pairing;
      while(this.data.queue.length) {
        const item=this.data.queue[0];
        if(item.sessionId!==p.id) throw new Error('Pending events belong to another listener session.');
        const ack=await this.request(p.origin,`/api/listener/sessions/${p.id}/events`,{events:[item.event]},p.token);
        if(!Array.isArray(ack.acceptedIds) || !ack.acceptedIds.includes(item.event.id)) throw new Error('Website has not acknowledged the transcript.');
        this.data.queue.shift(); this.save();
      }
      this.message='Connected to the Auction tab.';
    } catch(error) {this.message=error.message;}
    finally {this.sending=false;}
  }
  async heartbeat(recording=false) {
    if(!this.data.pairing) return;
    const p=this.data.pairing;
    try {
      await this.request(p.origin,`/api/listener/sessions/${p.id}/heartbeat`,{recording,pending:this.data.queue.length},p.token);
    } catch(error) {this.message=error.message;}
  }
}
