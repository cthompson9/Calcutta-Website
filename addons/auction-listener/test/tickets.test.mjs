import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ListenerTickets} from '../hosted/tickets.mjs';
function setup(){
  const tickets=new Map(),sessions=new Map();let now=1000000,open=true;
  const repository={
    async createTicket(row){tickets.set(row.hash,row);},
    async getSession(id){return sessions.get(id);},
    async withTicket(hash,callback){
      const row=tickets.get(hash);
      return callback({getTicket:async()=>row,getOpenAuction:async()=>open?{id:'42',name:'Auction'}:null,
        getSession:async id=>sessions.get(id),activateSession:async s=>sessions.set(s.id,s),
        markRedeemed:async values=>Object.assign(row,values)});
    },
  };
  return {service:new ListenerTickets({repository,secret:'s'.repeat(32),now:()=>now}),sessions,
    expire:()=>{now+=91000;},complete:()=>{open=false;}};
}
async function issued(service){
  const result=await service.issue('42','https://thecalcutta.app');
  const params=new URLSearchParams(new URL(result.launchUrl).hash.slice(1));
  return {ticket:params.get('ticket'),origin:params.get('origin'),redemptionId:randomUUID()};
}
test('ticket can be redeemed once; identical retry returns same scoped credential',async()=>{
  const {service}=setup();const request=await issued(service);
  const first=await service.redeem(request);assert.deepEqual(await service.redeem(request),first);
  await assert.rejects(service.redeem({...request,redemptionId:randomUUID()}),/already used/);
  assert.equal((await service.authenticate(first.id,first.token)).auctionId,'42');
});
test('wrong origin and expired ticket cannot redeem',async()=>{
  const {service,expire}=setup();const request=await issued(service);
  await assert.rejects(service.redeem({...request,origin:'https://evil.example'}),/expired/);
  expire();await assert.rejects(service.redeem(request),/expired/);
});
test('completed auction and revoked credential fail closed',async()=>{
  const {service,complete,sessions}=setup();const request=await issued(service);
  const paired=await service.redeem(request);
  await assert.rejects(service.authenticate(paired.id,'x'.repeat(43)),/Unauthorized/);
  sessions.get(paired.id).revokedAt=new Date().toISOString();
  await assert.rejects(service.authenticate(paired.id,paired.token),/Unauthorized/);
  complete();await assert.rejects(service.redeem(request),/complete/);
});
