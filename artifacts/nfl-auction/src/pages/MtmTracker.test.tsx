import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetPayoutHistoryChart } from "./MtmTracker";

describe("NetPayoutHistoryChart", () => {
  it("renders a connected team path after two successful weekly points", () => {
    render(
      <NetPayoutHistoryChart
        valuations={[
          {
            entryId: 7,
            teamId: 12,
            teamName: "Buffalo Bills",
            expectedPoints: "20",
            expectedPayout: "1600",
            previousExpectedPayout: "1400",
            auctionPrice: "1500",
            mtmMultiple: "1.07",
            owners: [],
            history: [
              {
                snapshotId: 101,
                label: "Week 0",
                asOf: "2026-08-25T12:00:00.000Z",
                expectedPayout: 1400,
                auctionPrice: 1500,
                netPayout: -100,
              },
              {
                snapshotId: 102,
                label: "Week 1",
                asOf: "2026-09-01T12:00:00.000Z",
                expectedPayout: 1600,
                auctionPrice: 1500,
                netPayout: 100,
              },
            ],
          },
        ]}
      />,
    );

    const path = screen.getByTestId("net-payout-path-7");
    expect(path.getAttribute("d")).toMatch(/^M[^L]+L/);
    expect(path).toHaveAttribute("stroke", "#00338D");
    expect(screen.getByText("2 weekly marks")).toBeInTheDocument();
  });
});