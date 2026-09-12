import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MtmGameEvSwing, MtmTeamEvSwing } from "@workspace/api-client-react";
import { NetPayoutHistoryChart, PipelineFailureNotice, UpcomingEvSwings } from "./MtmTracker";

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
    owners: [{
      bidderId: 1,
      bidderName: "Alpha Consortium",
      holdings: [{
        teamId: eventId * 2,
        teamName: awayName,
        signedShare: -0.25,
        available,
        qualityStatus: available ? "good" : "insufficient",
        baselineOwnedExpectedPayout: available ? -25 : null,
        winOwnedExpectedPayout: available ? -32.5 : null,
        lossOwnedExpectedPayout: available ? -18.75 : null,
        benefitOfWin: available ? -7.5 : null,
        costOfLoss: available ? -6.25 : null,
        totalEvSwing: available ? -13.75 : null,
        effectiveSampleSize: available ? 400 : 12,
      }],
    }],
  };
}

describe("NetPayoutHistoryChart", () => {
  it("renders refreshes within the same week at distinct timestamp positions", () => {
    const { container } = render(
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
              {
                snapshotId: 103,
                label: "Week 1",
                asOf: "2026-09-01T18:00:00.000Z",
                expectedPayout: 1650,
                auctionPrice: 1500,
                netPayout: 150,
              },
            ],
          },
        ]}
      />,
    );

    const path = screen.getByTestId("net-payout-path-7");
    expect(path.getAttribute("d")).toMatch(/^M[^L]+L/);
    expect(path).toHaveAttribute("stroke", "#00338D");
    expect(screen.getByText("3 refresh points")).toBeInTheDocument();
    const circles = [...container.querySelectorAll("circle")];
    expect(circles).toHaveLength(3);
    expect(circles[1]?.getAttribute("cx")).not.toBe(circles[2]?.getAttribute("cx"));
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
    expect(screen.getByRole("group", { name: "Week 3" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Week 4" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Week 5" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual([
      "Week 3",
      "Week 4",
      "Week 5",
    ]);
    const weekFour = screen.getByTestId("ev-swing-week-4");
    const games = within(weekFour).getAllByTestId("ev-swing-game");
    expect(within(weekFour).getByRole("article", { name: "Alpha Away @ Other Home" })).toBe(games[0]);
    expect(within(weekFour).getByRole("article", { name: "Zulu Away @ Home Four" })).toBe(games[1]);
    expect(within(weekFour).getAllByRole("heading", { level: 5 }).map((heading) => heading.textContent)).toEqual([
      "Alpha Away @ Other Home",
      "Zulu Away @ Home Four",
    ]);
    expect(games[0]).toHaveTextContent("Alpha Away @ Other Home");
    expect(games[1]).toHaveTextContent("Zulu Away @ Home Four");
    expect(within(screen.getByTestId("ev-swing-week-3")).getAllByText("$55 swing")).toHaveLength(2);
    expect(within(screen.getByTestId("ev-swing-week-3")).getAllByText("Benefit of win")).toHaveLength(2);
    expect(within(screen.getByTestId("ev-swing-week-3")).getAllByText("Cost of loss")).toHaveLength(2);
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

  it("shows signed consortium exposure and carries through unavailable quality", async () => {
    const user = userEvent.setup();
    render(<UpcomingEvSwings games={[game(3, 3, "Bills", "Jets")]} />);
    await user.click(screen.getByRole("button", { name: "By Owner" }));
    const group = screen.getByTestId("ev-swing-owner-group");
    const owner = screen.getByTestId("ev-swing-owner");
    expect(group).toHaveTextContent("Alpha Consortium");
    expect(owner).toHaveTextContent("Week 3");
    expect(owner).toHaveTextContent("Bills");
    expect(owner).toHaveTextContent("−$14 swing");
    expect(owner).not.toHaveTextContent("Short 25%");
    expect(owner).toHaveTextContent("Cost of win");
    expect(owner).toHaveTextContent("Benefit of loss");
    expect(owner).toHaveTextContent("$8");
    expect(owner).toHaveTextContent("$6");
    expect(owner).not.toHaveTextContent("Benefit of win");
    expect(owner).not.toHaveTextContent("Cost of loss");
    expect(owner).not.toHaveTextContent("+$");

    render(<UpcomingEvSwings games={[game(4, 4, "Weak Team", "Other", false)]} />);
    await user.click(screen.getAllByRole("button", { name: "By Owner" })[1]);
    const holdings = screen.getAllByTestId("ev-swing-owner-holding");
    expect(holdings.at(-1)).toHaveTextContent("Unavailable");
    expect(holdings.at(-1)).not.toHaveTextContent("$0.00");
  });

  it("filters both views and orders owner exposure by consortium then team", async () => {
    const user = userEvent.setup();
    const ownerGame = game(8, 8, "Zebra Team", "Alpha Team");
    ownerGame.owners = [
      {
        bidderId: 2,
        bidderName: "Zulu Consortium",
        holdings: [{ ...ownerGame.owners[0].holdings[0], teamName: "Zebra Team", teamId: 16 }],
      },
      {
        bidderId: 1,
        bidderName: "Alpha Consortium",
        holdings: [
          { ...ownerGame.owners[0].holdings[0], teamName: "Beta Team", teamId: 17 },
          { ...ownerGame.owners[0].holdings[0], teamName: "Alpha Team", teamId: 18 },
        ],
      },
    ];
    render(<UpcomingEvSwings games={[ownerGame]} />);

    const filter = screen.getByRole("searchbox", { name: "Filter teams" });
    await user.type(filter, "Alpha Team");
    expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    expect(screen.queryByText("Zebra Team", { selector: "[data-testid='ev-swing-team'] span" })).not.toBeInTheDocument();

    await user.clear(filter);
    await user.click(screen.getByRole("button", { name: "By Owner" }));
    const ownerGroups = screen.getAllByTestId("ev-swing-owner-group");
    expect(ownerGroups.map((group) => group.querySelector("summary")?.textContent)).toEqual([
      "Alpha Consortium",
      "Zulu Consortium",
    ]);
    const ownerRows = screen.getAllByTestId("ev-swing-owner");
    expect(ownerRows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Week 8Alpha Team.*swing.*Cost of win.*Benefit of loss/s),
      expect.stringMatching(/^Week 8Beta Team.*swing.*Cost of win.*Benefit of loss/s),
      expect.stringMatching(/^Week 8Zebra Team.*swing.*Cost of win.*Benefit of loss/s),
    ]);

    const ownerFilter = screen.getByRole("searchbox", { name: "Filter owners and teams" });
    await user.type(ownerFilter, "Zulu");
    expect(screen.getAllByTestId("ev-swing-owner")).toHaveLength(1);
    expect(screen.getByTestId("ev-swing-owner-group")).toHaveTextContent("Zulu Consortium");
  });
});

describe("PipelineFailureNotice", () => {
  it("keeps the latest recalculation error visible while the prior mark remains selected", () => {
    render(<PipelineFailureNotice status={{
      id: 279,
      currentSnapshotId: 227,
      asOf: "2026-09-11T19:46:59.452Z",
      currentAsOf: "2026-09-01T14:20:33.303Z",
      status: "failed",
      error: "no simulated support for positive playoff target ARI:sb_berth",
      stale: true,
      staleReasons: [],
      diagnostics: null,
      valuations: [],
    }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Latest recalculation failed");
    expect(screen.getByRole("alert")).toHaveTextContent("ARI:sb_berth");
    expect(screen.getByRole("alert")).toHaveTextContent("still showing the last successful mark");
  });

  it("clears after a successful recalculation", () => {
    const { container } = render(<PipelineFailureNotice status={{
      id: 280,
      currentSnapshotId: 280,
      asOf: "2026-09-11T20:00:00.000Z",
      currentAsOf: "2026-09-11T20:00:00.000Z",
      status: "ok",
      error: null,
      stale: false,
      staleReasons: [],
      diagnostics: null,
      valuations: [],
    }} />);
    expect(container).toBeEmptyDOMElement();
  });
});