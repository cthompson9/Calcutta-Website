import assert from "node:assert/strict";
import test from "node:test";
import { AuctionProImportError, parseAuctionProPayload } from "./auctionProImport.ts";

function completeExport() {
  return {
    teams: Array.from({ length: 32 }, (_, index) => ({
      teamName: `Team ${index + 1}`,
      bidAmount: 100 + index,
      owners: [{ name: "Zach", share: 0.5 }, { name: "Ed", share: 0.5 }],
    })),
  };
}

test("AuctionPro import requires a complete 32-team JSON export", () => {
  const parsed = parseAuctionProPayload(completeExport());
  assert.equal(parsed.length, 32);
  assert.equal(parsed[0].owners[0].share, 0.5);

  const partial = completeExport();
  partial.teams.pop();
  assert.throws(
    () => parseAuctionProPayload(partial),
    (error) => error instanceof AuctionProImportError && error.statusCode === 422,
  );
});

test("AuctionPro import rejects duplicate teams before any database work", () => {
  const duplicate = completeExport();
  duplicate.teams[31].teamName = duplicate.teams[0].teamName;

  assert.throws(
    () => parseAuctionProPayload(duplicate),
    /more than once/i,
  );
});