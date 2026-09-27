import assert from "node:assert/strict";
import { test } from "node:test";
import { CreateAuctionConsortiumBody, FinalizeAuctionSaleBody } from "@workspace/api-zod";

test("generated auction request schemas require exactly one allocation identity", () => {
  const envelope = { expectedRevision: 0 };
  assert.equal(FinalizeAuctionSaleBody.safeParse({
    ...envelope, allocations: [{ bidderId: 1, share: 1 }],
  }).success, true);
  assert.equal(FinalizeAuctionSaleBody.safeParse({
    ...envelope, allocations: [{ consortiumId: 1, share: 1 }],
  }).success, true);
  assert.equal(FinalizeAuctionSaleBody.safeParse({
    ...envelope, allocations: [{ bidderId: 1, consortiumId: 1, share: 1 }],
  }).success, false);

  const consortiumEnvelope = { displayName: "Consortium", expectedRevision: 0 };
  assert.equal(CreateAuctionConsortiumBody.safeParse({
    ...consortiumEnvelope, owners: [{ bidderId: 1, share: 1 }],
  }).success, true);
  assert.equal(CreateAuctionConsortiumBody.safeParse({
    ...consortiumEnvelope, owners: [{ newBidderName: "New bidder", share: 1 }],
  }).success, true);
  assert.equal(CreateAuctionConsortiumBody.safeParse({
    ...consortiumEnvelope, owners: [{ bidderId: 1, newBidderName: "New bidder", share: 1 }],
  }).success, false);
});