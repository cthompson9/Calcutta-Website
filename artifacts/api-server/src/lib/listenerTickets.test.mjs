import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ListenerTickets} from './listenerTickets.ts';

function fixture() {
  let now=1000000;
  const rows=new Map(), sessions=new Map();
  const repository={
    createTicket:async row=>rows.set(row.hash,row),
    getSession:async id=>sessions.get(id),
    withTicket:async(hash,fn)=>fn({
      getTicket:async()=>rows.get(hash),
      getOpenAuction:async id=>({id,calcuttaId:id+10,name:`Calcutta ${id}`}),
      getSession:async id=>sessions.get(id),
      activateSession:async row=>sessions.set(row.id,row),
      markRedeemed:async data=>Object.assign(rows.get(hash),data),
      resumeSession:async(id,expiresAt)=>Object.assign(sessions.get(id),{expiresAt}),
    }),
  };
  const service=new ListenerTickets({repository,secret:'s'.repeat(32),now:()=>now});
  const issue=async(id=1)=>{
    const issued=await service.issue(id,'https://thecalcutta.app');
    return {...Object.fromEntries(new URLSearchParams(new URL(issued.launchUrl).hash.slice(1))),redemptionId:randomUUID()};
  };
  return {service,issue,sessions,advance:()=>{now+=50000000;}};
}
test('preview identifies destination without consuming ticket or creating credentials',async()=>{
  const f=fixture(), ticket=await f.issue();
  assert.equal((await f.service.preview(ticket)).auction.id,1);
  assert.equal(f.sessions.size,0);
  await f.service.redeem(ticket);assert.equal(f.sessions.size,1);
});
test('expired same-device session resumes with pending deliveries and identical receipt identity',async()=>{
  const f=fixture(), first=await f.service.redeem(await f.issue());
  f.sessions.get(first.id).pending=3;f.advance();
  const request={...await f.issue(),resume:{id:first.id,token:first.token}};
  const resumed=await f.service.redeem(request);
  assert.equal(resumed.id,first.id);assert.equal(resumed.token,first.token);
  assert.equal(f.sessions.size,1);assert.equal(f.sessions.get(first.id).pending,3);
  assert.equal((await f.service.authenticate(first.id,first.token)).id,first.id);
  assert.deepEqual(await f.service.redeem(request),resumed);
});
test('resume cannot transfer credentials to another auction or revive revoked/recording sessions',async()=>{
  const f=fixture(), first=await f.service.redeem(await f.issue());
  const resume={id:first.id,token:first.token};
  await assert.rejects(f.service.redeem({...await f.issue(2),resume}),/could not be resumed/);
  await assert.rejects(f.service.redeem({...await f.issue(),resume:{...resume,token:'x'.repeat(43)}}),/could not be resumed/);
  f.sessions.get(first.id).recording=true;
  await assert.rejects(f.service.redeem({...await f.issue(),resume}),/could not be resumed/);
  f.sessions.get(first.id).recording=false;f.sessions.get(first.id).revokedAt=new Date();
  await assert.rejects(f.service.redeem({...await f.issue(),resume}),/could not be resumed/);
});
