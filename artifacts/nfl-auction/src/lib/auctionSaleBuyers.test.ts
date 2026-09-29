import { describe, expect, it } from "vitest";
import { groupSaleBuyers, saleBuyerLabel, summarizeSaleBuyers } from "./auctionSaleBuyers";

const consortiumSale = [
  { bidderId: 1, bidderName: "Owner A", consortiumId: 10, consortiumName: "The Mojojojojojis", share: 0.25, cents: 2500 },
  { bidderId: 2, bidderName: "Owner B", consortiumId: 10, consortiumName: "The Mojojojojojis", share: 0.25, cents: 2500 },
  { bidderId: 3, bidderName: "Owner C", consortiumId: 11, consortiumName: "Another Consortium", share: 0.5, cents: 5000 },
];

describe("auction sale buyers", () => {
  it("shows a multi-owner consortium once per sale and preserves the split and total", () => {
    const buyers = groupSaleBuyers(consortiumSale);
    expect(buyers).toEqual([
      { key: "consortium:10", name: "The Mojojojojojis", share: 0.5, cents: 5000 },
      { key: "consortium:11", name: "Another Consortium", share: 0.5, cents: 5000 },
    ]);
    expect(saleBuyerLabel(consortiumSale)).toBe("The Mojojojojojis / Another Consortium");
    expect(saleBuyerLabel(consortiumSale.slice(0, 2))).toBe("The Mojojojojojis");
  });

  it("counts each consortium once per lot, not once per member", () => {
    const totals = summarizeSaleBuyers([
      { allocations: consortiumSale },
      { allocations: [{ ...consortiumSale[0], share: 1, cents: 9000 }] },
    ]);
    expect(totals.get("consortium:10")).toMatchObject({ lots: 2, cents: 14000 });
    expect(totals.get("consortium:11")).toMatchObject({ lots: 1, cents: 5000 });
  });

  it("keeps direct individual buyers separate from consortia", () => {
    const buyers = groupSaleBuyers([
      ...consortiumSale.slice(0, 2),
      { bidderId: 4, bidderName: "Independent", consortiumId: null, consortiumName: null, share: 0.5, cents: 5000 },
    ]);
    expect(buyers.map((buyer) => buyer.name)).toEqual(["The Mojojojojojis", "Independent"]);
  });
});