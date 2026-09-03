import assert from "node:assert/strict";
import test from "node:test";

const { buildAuctionResults } = await import("./auctionResults.ts");

test("auction results consolidate split ownership into one historical team row", () => {
  const results = buildAuctionResults([
    {
      teamId: 17,
      teamName: "New England Patriots",
      bidAmount: "175",
      winnerName: "Zach",
      draftOrder: 8,
    },
    {
      teamId: 17,
      teamName: "New England Patriots",
      bidAmount: "175",
      winnerName: "Craig",
      draftOrder: 8,
    },
    {
      teamId: 2,
      teamName: "Buffalo Bills",
      bidAmount: "250",
      winnerName: "Ian",
      draftOrder: 3,
    },
  ]);

  assert.deepEqual(results, [
    {
      teamId: 2,
      teamName: "Buffalo Bills",
      bidAmount: 250,
      winnerName: "Ian",
      draftOrder: 3,
    },
    {
      teamId: 17,
      teamName: "New England Patriots",
      bidAmount: 175,
      winnerName: "Craig / Zach",
      draftOrder: 8,
    },
  ]);
});