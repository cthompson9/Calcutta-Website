import { afterEach, describe, expect, it, vi } from "vitest";
import { equalOwnerShares } from "./AdminDialogs";
import { groupedSaleAllocations } from "./SaleCorrectionDialog";
import { addConsortium, editConsortium, recordSale, correctSale } from "./admin-actions";
import type { AuctionConsortium } from "@workspace/api-client-react";

describe("commissioner ownership allocations", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("splits hundredths exactly for arbitrary owner counts", () => {
    for (const count of [1, 3, 7, 19, 137]) {
      const split = equalOwnerShares(Array.from({ length: count }, () => ({ newBidderName: "", percent: "" })));
      expect(split.reduce((sum, owner) => sum + Math.round(Number(owner.percent) * 100), 0)).toBe(10000);
      expect(new Set(split.slice(0, -1).map(owner => owner.percent)).size).toBeLessThanOrEqual(1);
    }
  });

  it("groups member allocations by consortium and falls back to owner for legacy records", () => {
    const roster = [
      { id: 8, bidderId: null, owners: [{ bidderId: 21 }, { bidderId: 22 }] },
      { id: 9, bidderId: 23, owners: [{ bidderId: 23 }] },
    ] as unknown as AuctionConsortium[];
    expect(groupedSaleAllocations([
      { consortiumId: 8, bidderId: 21, share: "0.200000" },
      { consortiumId: 8, bidderId: 22, share: "0.300000" },
      { consortiumId: null, bidderId: 23, share: "0.500000" },
    ], roster)).toEqual([
      { consortiumId: "8", share: "50.00" },
      { consortiumId: "9", share: "50.00" },
    ]);
  });

  it("sends owner and consortium IDs with the expected revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchMock);
    await addConsortium(4, 5, "West table", [{ bidderId: 21, share: 0.6 }, { newBidderName: "Mara", share: 0.4 }], "key", 12);
    await editConsortium(4, 5, 8, { owners: [{ bidderId: 21, share: 1 }] }, "key", 13);
    await recordSale(4, 5, 6, 204, [{ consortiumId: 8, share: 1 }], 14, "key");
    await correctSale(4, 5, 6, 205, [{ consortiumId: 8, share: 1 }], "Correction", "key", 15);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ owners: [{ bidderId: 21, share: 0.6 }, { newBidderName: "Mara", share: 0.4 }], expectedRevision: 12 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ owners: [{ bidderId: 21, share: 1 }], expectedRevision: 13 });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ allocations: [{ consortiumId: 8, share: 1 }], expectedRevision: 14 });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({ allocations: [{ consortiumId: 8, share: 1 }], expectedRevision: 15 });
  });
});