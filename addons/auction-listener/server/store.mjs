import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { defaultLots, validateLots } from './lots.mjs';
import { interpret, normalize } from './interpreter.mjs';

const fresh = lots => ({ id:randomUUID(), revision:0, createdAt:new Date().toISOString(), lots, currentLotId:null, sales:[], reviews:[], history:[], seen:[], uploads:[], transcript:[], pending:null, lastRelative:{} });
export class AuctionStore {
  constructor(file) {
    this.file = file;
    this.state = file && existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : fresh(defaultLots);
    this.listeners = new Set();
  }
  snapshot() {
    const { seen, pending, lastRelative, ...visible } = this.state;
    return structuredClone({...visible,pendingAnnouncement:pending?.text??null});
  }
  change(fn) {
    const next = structuredClone(this.state);
    const result = fn(next);
    next.revision++;
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive:true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next), { mode:0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    }
    this.state = next;
    for (const listener of this.listeners) listener(this.snapshot());
    return result;
  }
  newSession(lots) {
    const next = fresh(lots ? validateLots(lots) : this.state.lots);
    if (this.file) writeFileSync(`${this.file}.${this.state.id}.archive.json`, JSON.stringify(this.state), { mode:0o600 });
    this.change(s => { for (const key of Object.keys(s)) delete s[key]; Object.assign(s,next); });
  }
  uploadIntent() {
    const id = randomUUID();
    this.change(s => s.uploads.push({ intentId:id, id:null, status:'creating', createdAt:new Date().toISOString() }));
    return id;
  }
  uploadCreated(intentId, id) {
    this.change(s => { const u=s.uploads.find(u=>u.intentId===intentId); if (!u) throw new Error('Recording session changed.'); u.id=id; u.status='ready'; });
  }
  uploadStatus(id, status, recordingId = null) {
    this.change(s => {
      const u=s.uploads.find(u=>u.id===id || u.intentId===id);
      if (!u) throw new Error('Unknown recording.');
      if (['complete','failed'].includes(u.status) && !['complete','failed'].includes(status)) return;
      u.status=status; u.recordingId=recordingId ?? u.recordingId;
    });
  }
  applyLifecycle(event) {
    if (!['sdk_upload.complete','sdk_upload.failed','sdk_upload.recording_started','sdk_upload.recording_ended'].includes(event.event)) return;
    this.uploadStatus(event.data?.sdk_upload?.id, event.event.slice('sdk_upload.'.length), event.data?.recording?.id);
  }
  ingest({ sessionId, uploadId, event, source='recall' }) {
    if (sessionId !== this.state.id) throw new Error('This transcript belongs to a previous rehearsal.');
    if (source === 'recall' && !this.state.uploads.some(u=>u.id === uploadId)) throw new Error('Unknown recording.');
    if (!['transcript.data','transcript.partial_data'].includes(event?.event)) return;
    const d=event.data?.data;
    if (!Array.isArray(d?.words) || d.words.length > 2000 || d.words.some(w=>typeof w.text !== 'string')) throw new Error('Invalid transcript.');
    const text=d.words.map(w=>w.text).join(' ').trim();
    if (!text || text.length > 20000) return;
    const first=d.words[0]?.start_timestamp?.relative;
    const last=d.words.at(-1)?.end_timestamp?.relative ?? first;
    const speaker=String(d.participant?.id ?? 'unknown');
    const key=createHash('sha256').update(JSON.stringify([uploadId,speaker,event.event,first,last,text])).digest('hex');
    if (this.state.seen.includes(key)) return;
    this.change(s => {
      s.seen.push(key);
      const row={ id:key, text, source, final:event.event === 'transcript.data', receivedAt:new Date().toISOString(), speaker:d.participant?.name ?? 'Speaker' };
      s.transcript=[row,...s.transcript.filter(t=>t.final)].slice(0,100);
      if (!row.final) return;
      const stream=`${uploadId}:${speaker}`;
      if (Number.isFinite(first) && first < (s.lastRelative[stream] ?? -1)) {
        s.reviews.unshift({id:randomUUID(),text,reason:'Delayed transcript received out of order; review manually.'}); return;
      }
      if (Number.isFinite(first)) s.lastRelative[stream]=first;
      const now=Date.now();
      let input=text;
      if (s.pending && s.pending.stream===stream && now-s.pending.at < 8000 && !/\b(?:next up|up next|nominate)\b/i.test(text)) input=`${s.pending.text} ${text}`;
      else if(s.pending) s.reviews.unshift({id:randomUUID(),text:s.pending.text,reason:'Incomplete sale announcement. Enter the result manually.'});
      s.pending=null;
      const segments=input.split(/[.!?]\s+(?=(?:next\b|up next\b|nominate\b|sold\b))/i);
      for (const segment of segments) {
        const action=interpret(segment,s);
        if (action.kind==='nomination') s.currentLotId=action.lotId;
        if (action.kind==='sale') {
          const sale={ id:randomUUID(),lotId:action.lotId,priceCents:action.priceCents,owners:action.owners,needsShares:action.needsShares,revision:1,source,createdAt:row.receivedAt,transcript:segment };
          s.sales.push(sale); s.history.push({kind:'sale',sale:structuredClone(sale),at:row.receivedAt});
          s.currentLotId=null;
        }
        if (action.kind==='review') s.reviews.unshift({id:randomUUID(),text:segment,reason:action.reason});
        if (action.kind==='pending') s.pending={text:segment,stream,at:now};
      }
      s.reviews=s.reviews.slice(0,100);
    });
  }
  edit({ saleId, lotId, priceCents, owners, expectedRevision }) {
    if (!this.state.lots.some(l=>l.id===lotId) || !Number.isInteger(priceCents) || priceCents <= 0 || priceCents > 100000000) throw new Error('Choose a known lot and a positive price up to $1,000,000.');
    if (!Array.isArray(owners) || !owners.length || owners.length > 8 || owners.some(o=>typeof o.name !== 'string' || !o.name.trim() || o.name.length > 80 || !Number.isInteger(o.basisPoints) || o.basisPoints<=0) || owners.reduce((n,o)=>n+o.basisPoints,0)!==10000) throw new Error('Owner percentages must add to exactly 100%.');
    if (new Set(owners.map(o=>normalize(o.name))).size!==owners.length) throw new Error('Combine duplicate owner names.');
    this.change(s => {
      const sale=s.sales.find(r=>r.id===saleId);
      if (saleId && !sale) throw new Error('Result no longer exists.');
      if (sale && expectedRevision!==sale.revision) throw new Error('This result changed. Close the editor and try again.');
      if (s.sales.some(r=>r.lotId===lotId && r.id!==saleId)) throw new Error('That lot already has a result.');
      const before=sale ? structuredClone(sale) : null;
      const after={...(sale??{id:randomUUID(),createdAt:new Date().toISOString()}),lotId,priceCents,owners:owners.map(o=>({...o,name:o.name.trim()})),needsShares:false,revision:(sale?.revision??0)+1,source:'commissioner'};
      if (sale) Object.assign(sale,after); else s.sales.push(after);
      s.history.push({kind:'correction',before,after:structuredClone(after),at:new Date().toISOString()});
      if (s.currentLotId===lotId) s.currentLotId=null;
    });
  }
}
