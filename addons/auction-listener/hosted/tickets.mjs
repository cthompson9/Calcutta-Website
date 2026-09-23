import {randomBytes, randomUUID, createHash, createHmac, timingSafeEqual} from 'node:crypto';
export const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail=message=>{throw new Error(message);};
const ticketShape=value=>typeof value==='string' && /^[A-Za-z0-9_-]{43}$/.test(value);
/**
 * Repository operations MUST be durable and transactional (see contract.md).
 * No network/Express/database dependency: unit-testable security policy.
 */
export class ListenerTickets {
  constructor({repository,secret,now=Date.now}) {
    if(typeof secret!=='string' || secret.length<32) throw new Error('Listener signing secret must contain at least 32 characters.');
    Object.assign(this,{repository,secret,now});
  }
  async issue(auctionId,origin) {
    if(new URL(origin).origin!==origin || !origin.startsWith('https://')) fail('HTTPS origin required.');
    const ticket=randomBytes(32).toString('base64url');
    const expiresAt=new Date(this.now()+90_000).toISOString();
    await this.repository.createTicket({hash:digest(ticket),auctionId,origin,expiresAt});
    const fragment=new URLSearchParams({origin,ticket});
    return {launchUrl:`calcutta-listener://connect#${fragment}`,expiresAt};
  }
  async redeem({ticket,redemptionId,origin}) {
    if(!ticketShape(ticket) || !/^[0-9a-f-]{36}$/.test(redemptionId??'')) fail('Invalid connection ticket.');
    return this.repository.withTicket(digest(ticket),async tx=>{
      const row=await tx.getTicket();
      if(!row || row.origin!==origin || Date.parse(row.expiresAt)<=this.now()) fail('Connection link expired. Open the listener from the Auction tab again.');
      const auction=await tx.getOpenAuction(row.auctionId);
      if(!auction) fail('Auction is unavailable or complete.');
      if(row.redemptionId && row.redemptionId!==redemptionId) fail('Connection ticket already used.');
      // Deterministic credential permits a lost pair response to be retried safely.
      const token=createHmac('sha256',this.secret).update(`calcutta-listener-v1:${row.hash}:${redemptionId}`).digest('base64url');
      if(row.sessionId) {
        const existing=await tx.getSession(row.sessionId);
        if(!existing || existing.revokedAt || Date.parse(existing.expiresAt)<=this.now()) fail('Listener session is no longer active.');
        return {id:existing.id,token,expiresAt:existing.expiresAt,auction};
      }
      const session={id:randomUUID(),auctionId:row.auctionId,tokenHash:digest(token),expiresAt:new Date(this.now()+12*60*60*1000).toISOString()};
      // Revoke/replace only idle sessions; reject if recording or queued delivery is active.
      await tx.activateSession(session);
      await tx.markRedeemed({redemptionId,sessionId:session.id});
      return {id:session.id,token,expiresAt:session.expiresAt,auction};
    });
  }
  async authenticate(id,token) {
    if(!ticketShape(token) || !/^[0-9a-f-]{36}$/.test(id??'')) fail('Unauthorized listener.');
    const session=await this.repository.getSession(id);
    if(!session || session.revokedAt || Date.parse(session.expiresAt)<=this.now() || !same(session.tokenHash,digest(token))) fail('Unauthorized listener.');
    return session;
  }
}
