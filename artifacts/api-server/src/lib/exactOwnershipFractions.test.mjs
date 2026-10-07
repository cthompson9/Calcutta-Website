import test from "node:test";
import assert from "node:assert/strict";
import { exactShareVector, fraction, addFractions, allocateExactCents, fractionNumber } from "./exactOwnershipFractions.ts";
import { validateFractionSnapshot } from "./exactPrimaryOwnership.ts";
import { expandSaleAllocations, validateAllocationInput } from "./auctionAllocations.ts";
import { auctionConsortiaTable } from "@workspace/db";

test("thirds and sixths are rational, not rounded percentages", () => {
  for (const values of [[.33,.33,.33],[.33,.33,.34],[.3334,.3333,.3333],[1/3,1/3,1/3]]) {
    assert.deepEqual(exactShareVector(values),[fraction(1n,3n),fraction(1n,3n),fraction(1n,3n)]);
  }
  assert.deepEqual(exactShareVector([.6667,.1667,.1666]),[fraction(2n,3n),fraction(1n,6n),fraction(1n,6n)]);
  assert.deepEqual(exactShareVector([.21,.79]),[fraction(21n,100n),fraction(79n,100n)]);
  assert.throws(()=>exactShareVector([.33,.5]),/100%/);
});
test("purchase costs use fractions before cent rounding", () => {
  const rows=(values)=>exactShareVector(values).map((share,id)=>({id,share}));
  assert.deepEqual([...allocateExactCents(270000,rows([.3334,.3333,.3333])).values()],[90000,90000,90000]);
  assert.deepEqual([...allocateExactCents(435000,rows([.6667,.1667,.1666])).values()],[290000,72500,72500]);
  assert.deepEqual([...allocateExactCents(1,rows([.3334,.3333,.3333])).values()],[1,0,0]);
});
test("signed trade stakes retain their exact terms and conserve gross cents", () => {
  const share=addFractions(fraction(1n,3n),fraction(-1n,10n));
  assert.equal(fractionNumber(share),7/30);
  const rows=[{id:1,share:fraction(-1n,10n)},{id:2,share:fraction(11n,10n)}];
  const cents=allocateExactCents(101,rows);
  assert.equal(cents.get(1)+cents.get(2),101);
  assert.equal(cents.get(1),-10);
});
test("exact audit snapshots fail closed on incomplete or duplicate shares", () => {
  const saved={kind:"exact_fraction_split",calcuttaId:2061,entryId:1,owners:[1,2,3].map(bidderId=>({
    bidderId,storedShare:".3333",costCents:90000,numerator:"1",denominator:"3",
  }))};
  assert.deepEqual(validateFractionSnapshot(saved),saved);
  assert.throws(()=>validateFractionSnapshot({...saved,owners:saved.owners.slice(1)}),/100%/);
  assert.throws(()=>validateFractionSnapshot({...saved,owners:[saved.owners[0],saved.owners[0]]}),/Invalid/);
});
test("XIII expands consortium and direct buyer fractions without basis-point cost bias", async () => {
  const tx={select:()=>({from:table=>({where:async()=>table===auctionConsortiaTable
    ? [{id:4,active:1},{id:1,active:1}]
    : [{consortiumId:4,bidderId:3,ownerShare:"1"},{consortiumId:1,bidderId:5,ownerShare:".5"},{consortiumId:1,bidderId:7,ownerShare:".5"}]})})};
  for (const inputs of [
    [{consortiumId:4,share:.6667},{consortiumId:1,share:.3333}],
    [{bidderId:3,share:.66},{consortiumId:1,share:.33}],
  ]) {
    const rows=await expandSaleAllocations(tx,1,inputs,435000,true);
    assert.deepEqual(rows.map(row=>row.cents),[290000,72500,72500]);
    assert.deepEqual(rows.map(row=>`${row.numerator}/${row.denominator}`),["2/3","1/6","1/6"]);
    assert.equal(rows.reduce((total,row)=>total+row.basisPoints,0),10000);
    assert.equal(rows.reduce((total,row)=>total+row.cents,0),435000);
  }
});
test("NFL validation keeps literal shares and original precision requirements", () => {
  assert.throws(()=>validateAllocationInput([1,2,3].map(bidderId=>({bidderId,share:.33}))),/100%/);
  assert.doesNotThrow(()=>validateAllocationInput([{bidderId:1,share:.33},{bidderId:2,share:.67}]));
  assert.throws(()=>validateAllocationInput([{bidderId:1,share:1/3},{bidderId:2,share:2/3}]),/four decimals/);
});
