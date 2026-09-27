import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AuctionSnapshot } from "@workspace/api-client-react";
import { AuctionRosterSummary } from "./AuctionRosterSummary";
import { auctionConsortiumsByBidderId, auctionConsortiumsByBidderName } from "@/lib/ownerDisplay";

const auction: AuctionSnapshot = {
  id: 12, calcuttaId: 9, status: "setup", revision: 0,
  currentLotId: null, createdAt: "2026-09-01T00:00:00Z", startedAt: null, completedAt: null,
  lots: [], sales: [],
  metrics: { poolSizeCents: 0, lotsSold: 0, totalLots: 0, averageSaleCents: null },
  consortia: [
    { id: 21, auctionId: 12, displayName: "North Star", active: 1, owners: [
      { bidderId: 31, bidderName: "Alex", share: 0.6 },
      { bidderId: 32, bidderName: "Blair", share: 0.4 },
    ] },
    { id: 22, auctionId: 12, displayName: "Second Group", active: 1, owners: [
      { bidderId: 33, bidderName: "Casey", share: 1 },
    ] },
  ],
};

describe("auction roster shared across Results and Analysis", () => {
  it("shows draft consortia and owner shares without inventing auction costs", () => {
    render(<AuctionRosterSummary auction={auction} />);
    const roster = screen.getByTestId("auction-roster-summary");
    expect(within(roster).getByText("North Star")).toBeInTheDocument();
    expect(within(roster).getByText("Alex 60.00% · Blair 40.00%")).toBeInTheDocument();
    expect(within(roster).getByText("Casey 100.00%")).toBeInTheDocument();
    expect(within(roster).getAllByText("No sold lots")).toHaveLength(2);
    expect(within(roster).queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("shows only recorded sale costs and uses pool-scoped consortium names", () => {
    const withSale: AuctionSnapshot = {
      ...auction, status: "live", sales: [{
        id: 41, auctionId: 12, lotId: 11, totalCents: 1200, source: "manual",
        allocations: [
          { saleId: 41, consortiumId: 21, bidderId: 31, bidderName: "Alex", consortiumName: "North Star", share: "0.600000", cents: 720 },
          { saleId: 41, consortiumId: 21, bidderId: 32, bidderName: "Blair", consortiumName: "North Star", share: "0.400000", cents: 480 },
        ],
      }],
    };
    render(<AuctionRosterSummary auction={withSale} />);
    expect(screen.getByText("1 sold lot · $12.00 cost")).toBeInTheDocument();
    expect(screen.getByText("No sold lots")).toBeInTheDocument();
    expect(auctionConsortiumsByBidderId(withSale, undefined).get(31)).toBe("North Star");
    expect(auctionConsortiumsByBidderName(withSale, undefined).get("Blair")).toBe("North Star");
  });
});