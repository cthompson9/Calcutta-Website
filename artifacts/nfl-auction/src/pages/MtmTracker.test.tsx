import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MtmGameEvSwing, MtmTeamEvSwing } from "@workspace/api-client-react";
import { NetPayoutHistoryChart, UpcomingEvSwings } from "./MtmTracker";

function swing(teamId: number, teamName: string, available = true): MtmTeamEvSwing {
  return {
    teamId,
    teamName,
    available,
    qualityStatus: available ? "good" : "insufficient",
    baselineGrossExpectedPayout: available ? 100 : null,
    winGrossExpectedPayout: available ? 130 : null,
    lossGrossExpectedPayout: available ? 75 : null,
    benefitOfWin: available ? 30 : null,
    costOfLoss: available ? 25 : null,
    totalEvSwing: available ? 55 : null,
    sampleCount: 500,
    sampleShare: 0.4,
    effectiveSampleSize: available ? 400 : 12,
    standardError: 2,
  };
}

function game(eventId: number, week: number, awayName: string, homeName: string, available = true): MtmGameEvSwing {
  return {
    eventId,
    week,
    awayTeamId: eventId * 2,
    homeTeamId: eventId * 2 + 1,
    teams: [
      swing(eventId * 2, awayName, available),
      swing(eventId * 2 + 1, homeName),
    ],
  };
}

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

describe("UpcomingEvSwings", () => {
  it("groups and sorts only the next three available weeks", () => {
    render(<UpcomingEvSwings games={[
      game(6, 6, "Late Away", "Late Home"),
      game(4, 4, "Zulu Away", "Home Four"),
      game(3, 3, "Bills", "Jets"),
      game(5, 4, "Alpha Away", "Other Home"),
      game(7, 5, "Week Five Away", "Week Five Home"),
    ]} />);

    expect(screen.getByText("Weeks 3, 4, 5")).toBeInTheDocument();
    expect(screen.queryByText("Late Away @ Late Home")).not.toBeInTheDocument();
    const weekFour = screen.getByTestId("ev-swing-week-4");
    const games = within(weekFour).getAllByTestId("ev-swing-game");
    expect(games[0]).toHaveTextContent("Alpha Away @ Other Home");
    expect(games[1]).toHaveTextContent("Zulu Away @ Home Four");
    expect(within(screen.getByTestId("ev-swing-week-3")).getAllByText("$55 swing")).toHaveLength(2);
    expect(screen.getAllByText("+$30").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$25").length).toBeGreaterThan(0);
  });

  it("shows conditional quality instead of zero-valued swings", () => {
    render(<UpcomingEvSwings games={[game(3, 3, "Bills", "Jets", false)]} />);
    const billsRow = screen.getAllByTestId("ev-swing-team")[0];
    expect(within(billsRow).getByText("Unavailable")).toBeInTheDocument();
    expect(within(billsRow).getByText(/insufficient conditional quality · ESS 12/i)).toBeInTheDocument();
    expect(within(billsRow).queryByText("$0.00 swing")).not.toBeInTheDocument();
  });
});