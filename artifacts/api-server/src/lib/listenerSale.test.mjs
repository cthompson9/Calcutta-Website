import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { SQL, is } from 'drizzle-orm';
import { listenerResultSchema, resultFingerprint } from './listenerResult.ts';

// The service uses only this injected in-memory PostgreSQL instance. Never a hosted DB.
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
const schema = await import('@workspace/db');
const { finalizeAuctionSale } = await import('./finalizeAuctionSale.ts');
const tables=['calcuttasTable','auctionSessionsTable','auctionLotsTable','auctionConsortiaTable','auctionConsortiumOwnersTable','auctionSalesTable','auctionSaleAllocationsTable','auctionEventsTable','positionsTable','tradesTable','listenerSessionsTable'];
const nominationId='11111111-1111-4111-8111-111111111111';
const sessionId='22222222-2222-4222-8222-222222222222';
const requestId='33333333-3333-4333-8333-333333333333';
const valid={idempotencyKey:requestId,lotId:10,nominationId,totalCents:50000,allocations:[{consortiumId:1,basisPoints:6000},{consortiumId:2,basisPoints:4000}]};

async function fixture(t) {
  const pg=new PGlite(); await pg.waitReady; t.after(()=>pg.close());
  const db=drizzle(pg), dialect=new PgDialect();
  for(const name of tables) {
    const table=getTableConfig(schema[name]);
    const columns=table.columns.map(c=>{
      let def='';
      if(is(c.default,SQL))def=` DEFAULT ${dialect.sqlToQuery(c.default).sql}`;
      else if(c.default!==undefined)def=` DEFAULT '${(typeof c.default==='object'?JSON.stringify(c.default):String(c.default)).replaceAll("'","''")}'`;
      return `"${c.name}" ${c.getSQLType()}${c.primary?' PRIMARY KEY':''}${def}`;
    });
    await pg.exec(`CREATE TABLE "${table.name}" (${columns.join(',')});`);
  }
  await pg.exec(`
    CREATE UNIQUE INDEX sales_lot ON auction_sales(lot_id);
    CREATE UNIQUE INDEX events_key ON auction_events(auction_id,idempotency_key);
    CREATE UNIQUE INDEX events_sequence ON auction_events(auction_id,sequence);
    CREATE UNIQUE INDEX allocation_buyer ON auction_sale_allocations(sale_id,bidder_id);
    INSERT INTO calcuttas(id,season_id) VALUES(1,1);
    INSERT INTO auction_sessions(id,calcutta_id,status,current_lot_id,revision) VALUES(1,1,'live',10,0);
    INSERT INTO auction_lots(id,auction_id,entry_id,display_name,status,nomination_id) VALUES(10,1,100,'Chiefs','bidding','${nominationId}');
    INSERT INTO auction_consortia(id,auction_id,display_name,active) VALUES(1,1,'Alpha',1),(2,1,'Bravo',1);
    INSERT INTO auction_consortium_owners(auction_id,consortium_id,bidder_id,share) VALUES(1,1,101,.5),(1,1,102,.5),(1,2,103,1);
    INSERT INTO listener_sessions(id,auction_id,token_hash,expires_at) VALUES('${sessionId}',1,'unused','2099-01-01');
  `);
  const submit=(value=valid,overrides={})=>finalizeAuctionSale(1,1,value.lotId,{totalCents:value.totalCents,allocations:value.allocations.map(a=>({consortiumId:a.consortiumId,share:a.basisPoints/10000}))},{id:sessionId,key:`listener:${sessionId}:${value.idempotencyKey}`,requestId:value.idempotencyKey,fingerprint:resultFingerprint(value),nominationId:value.nominationId,...overrides},db);
  return {db,pg,submit};
}
test('result schema rejects fractional/duplicate/incomplete shares and fingerprints canonical order',()=>{
  assert.equal(listenerResultSchema.safeParse(valid).success,true);
  for(const allocations of [[{consortiumId:1,basisPoints:9999}],[{consortiumId:1,basisPoints:5000},{consortiumId:1,basisPoints:5000}],[{consortiumId:1,basisPoints:10000.1}]]) assert.equal(listenerResultSchema.safeParse({...valid,allocations}).success,false);
  assert.equal(resultFingerprint(valid),resultFingerprint({...valid,allocations:[...valid.allocations].reverse()}));
});
test('sale, expanded ownership and receipt commit once; identical retries are harmless',async t=>{
  const f=await fixture(t);const first=await f.submit();const second=await f.submit();assert.deepEqual(second,first);
  const sales=await f.db.select().from(schema.auctionSalesTable);assert.equal(sales.length,1);assert.equal(sales[0].source,'listener');
  const positions=await f.db.select().from(schema.positionsTable);assert.equal(positions.length,3);assert.deepEqual(positions.map(p=>Number(p.ownershipShare)),[.3,.3,.4]);
  assert.equal(positions.reduce((n,p)=>n+Math.round(Number(p.costBasis)*100),0),50000);
  const [auction]=await f.db.select().from(schema.auctionSessionsTable);assert.equal(auction.currentLotId,null);assert.equal(auction.revision,1);
  await assert.rejects(f.submit({...valid,totalCents:60000}),/different result/);
  assert.equal((await f.db.select().from(schema.auctionSalesTable))[0].totalCents,50000);
});
test('stale nomination, revoked credential and inactive consortium cannot write ownership',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.submit({...valid,nominationId:'44444444-4444-4444-8444-444444444444'}),/nominated lot changed/);
  await f.pg.exec('UPDATE auction_consortia SET active=0 WHERE id=1');await assert.rejects(f.submit(),/active consortium/);
  await f.pg.exec(`UPDATE auction_consortia SET active=1; UPDATE listener_sessions SET revoked_at=now()`);await assert.rejects(f.submit(),/expired/);
  assert.equal((await f.db.select().from(schema.positionsTable)).length,0);assert.equal((await f.db.select().from(schema.auctionSalesTable)).length,0);
});
test('database failure rolls back the sale and leaves it safe to retry',async t=>{
  const f=await fixture(t);
  await f.pg.exec(`ALTER TABLE positions ADD CONSTRAINT deliberate_failure CHECK(cost_basis < 0)`);
  await assert.rejects(f.submit());assert.equal((await f.db.select().from(schema.auctionSalesTable)).length,0);
  assert.equal((await f.db.select().from(schema.auctionEventsTable)).length,0);
  await f.pg.exec('ALTER TABLE positions DROP CONSTRAINT deliberate_failure');await f.submit();assert.equal((await f.db.select().from(schema.auctionSalesTable)).length,1);
});
test('manual finalization uses the same consortium expansion and protects existing sales',async t=>{
  const f=await fixture(t);await finalizeAuctionSale(1,1,10,{totalCents:50000,expectedRevision:0,allocations:[{consortiumId:1,share:1}]},undefined,f.db);
  assert.equal((await f.db.select().from(schema.positionsTable)).length,2);
  await assert.rejects(f.submit(),/not currently bidding/);
});
test('simultaneous retries acknowledge one sale; a different operation cannot sell the lot twice',async t=>{
  const f=await fixture(t);const receipts=await Promise.all([f.submit(),f.submit()]);assert.deepEqual(receipts[0],receipts[1]);
  await assert.rejects(f.submit({...valid,idempotencyKey:'55555555-5555-4555-8555-555555555555'}),/not currently bidding/);
  assert.equal((await f.db.select().from(schema.auctionSalesTable)).length,1);
});
