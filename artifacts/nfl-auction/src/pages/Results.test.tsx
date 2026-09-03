import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "@/components/layout/Shell";
import { SeasonProvider } from "@/hooks/useSeason";
import Results from "@/pages/Results";

const calcuttas = [
  {
    id: 8,
    seasonId: 8,
    name: "Calcutta VIII",
    sport: "NFL",
    year: 2025,
    isActive: false,
    isComplete: true,
  },
  {
    id: 3,
    seasonId: 3,
    name: "Calcutta III",
    sport: "NFL",
    year: 2023,
    isActive: false,
    isComplete: true,
  },
  {
    id: 1,
    seasonId: 1,
    name: "Calcutta I",
    sport: "NCAAM",
    year: 2022,
    isActive: false,
    isComplete: true,
  },
];

const historicalPools = [
  {
    id: 103,
    name: "Calcutta III",
    sport: "NFL",
    seasonYear: 2023,
    asOfDate: "2023-09-01",
    potSize: 10_000,
  },
  {
    id: 101,
    name: "Calcutta I",
    sport: "NCAAM",
    seasonYear: 2022,
    asOfDate: "2022-03-01",
    potSize: null,
  },
];

const historicalEntries = {
  103: [
    {
      id: 301,
      label: "Buffalo Bills",
      teams: [{ id: 31, name: "Buffalo Bills" }],
      ownership: [
        {
          ownerName: "Alex Owner",
          consortium: "North Star",
          label: "North Star",
        },
      ],
      price: null,
      priceAvailable: false,
      points: null,
      pointsAvailable: false,
      payout: null,
      payoutAvailable: false,
      tracking: null,
    },
  ],
  101: [
    {
      id: 101,
      label: "Duke",
      teams: [{ id: 11, name: "Duke" }],
      ownership: [],
      price: 100,
      priceAvailable: true,
      points: 4,
      pointsAvailable: true,
      payout: 150,
      payoutAvailable: true,
      tracking: "Final",
    },
  ],
} satisfies Record<number, unknown[]>;

const historicalOwners = {
  103: [
    {
      ownerName: "Alex Owner",
      consortium: "North Star",
      labels: ["North Star"],
      lotCount: 1,
      cost: null,
      costAvailable: false,
      payout: null,
      payoutAvailable: false,
    },
  ],
  101: [
    {
      ownerName: "Casey Owner",
      consortium: "Blue Bloods",
      labels: ["Blue Bloods"],
      lotCount: 1,
      cost: 100,
      costAvailable: true,
      payout: 150,
      payoutAvailable: true,
    },
  ],
} satisfies Record<number, unknown[]>;

const historicalTrades = {
  103: [
    {
      id: 901,
      sheetRef: "1",
      tradeDate: null,
      detail: "Alex trades 25% of Buffalo to Casey",
      scope: "entry",
      entryId: 301,
      entryLabel: "Buffalo Bills",
      fromOwnerId: 1,
      fromOwnerName: "Alex Owner",
      toOwnerId: 2,
      toOwnerName: "Casey Owner",
      pct: 0.25,
      cash: 125,
      cashAvailable: true,
      factor: null,
      basis: null,
      knownBookVariance: false,
      derivedCash: null,
      derivedCashAvailable: false,
      absoluteCashDifference: null,
      absoluteCashDifferenceAvailable: false,
      status: "approved",
    },
  ],
  101: [],
} satisfies Record<number, unknown[]>;

const liveOwnerRows = [
  {
    bidderId: 80,
    bidderName: "Live Owner",
    consortium: "Live Consortium",
    teamCount: 1,
    totalCost: 1_000,
    totalRealizedReturn: 0,
    totalNetReturn: -1_000,
    netPctReturn: -1,
    totalMtm: 1_200,
    totalNetMtm: 200,
    marketStatus: "fresh",
    marketStatusReasons: [],
    teams: [],
  },
];

vi.mock("@workspace/api-client-react", () => {
  const queryKey = (...args: unknown[]) => args;
  const emptyQuery = () => ({ data: [], isLoading: false });

  return {
    useGetCalcuttas: () => ({ data: calcuttas, isLoading: false }),
    useGetHistoricalPools: () => ({ data: historicalPools, isLoading: false }),
    useGetHistoricalPoolEntries: (poolId: number) => ({
      data: historicalEntries[poolId as keyof typeof historicalEntries] ?? [],
      isLoading: false,
    }),
    useGetHistoricalPoolOwners: (poolId: number) => ({
      data: historicalOwners[poolId as keyof typeof historicalOwners] ?? [],
      isLoading: false,
    }),
    useGetHistoricalPoolTrades: (poolId: number) => ({
      data: historicalTrades[poolId as keyof typeof historicalTrades] ?? [],
      isLoading: false,
    }),
    useGetResults: emptyQuery,
    useGetResultsByOwner: () => ({ data: liveOwnerRows, isLoading: false }),
    useGetBidders: emptyQuery,
    useGetSportPeriods: emptyQuery,
    useGetSeasons: emptyQuery,
    useGetResultsCompare: () => ({ data: undefined, isLoading: false }),
    useGetResultsAvailability: () => ({ data: undefined, isLoading: false }),
    useGetAuctionSummary: () => ({ data: undefined, isLoading: false }),
    useGetMtmSnapshots: emptyQuery,
    useGetTrades: emptyQuery,
    getGetResultsQueryKey: queryKey,
    getGetResultsByOwnerQueryKey: queryKey,
    getGetBiddersQueryKey: queryKey,
    getGetResultsCompareQueryKey: queryKey,
    getGetResultsAvailabilityQueryKey: queryKey,
    getGetAuctionSummaryQueryKey: queryKey,
    getGetMtmSnapshotsQueryKey: queryKey,
    getGetTradesQueryKey: queryKey,
    getGetHistoricalPoolEntriesQueryKey: queryKey,
    getGetHistoricalPoolOwnersQueryKey: queryKey,
    getGetHistoricalPoolTradesQueryKey: queryKey,
  };
});

function renderResults() {
  return render(
    <SeasonProvider>
      <Shell>
        <Results />
      </Shell>
    </SeasonProvider>,
  );
}

describe("Results Calcutta data source", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders normalized consortium and team rows for Calcutta III without zero-filling nulls", async () => {
    const user = userEvent.setup();
    renderResults();

    await user.selectOptions(screen.getByTestId("select-calcutta-desktop"), "3");

    const ownerRow = await screen.findByTestId("historical-owner-row");
    expect(within(ownerRow).getByText("North Star")).toBeInTheDocument();
    expect(within(ownerRow).getAllByText("—")).toHaveLength(4);
    expect(within(ownerRow).queryByText("$0.00")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("tab-byTeam"));

    const teamRow = await screen.findByTestId("historical-team-row");
    expect(within(teamRow).getByText("Buffalo Bills")).toBeInTheDocument();
    expect(within(teamRow).getByText("North Star")).toBeInTheDocument();
    expect(within(teamRow).getAllByText("—")).toHaveLength(5);
    expect(within(teamRow).queryByText("$0.00")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("tab-historicalTrades"));

    const tradeRow = await screen.findByTestId("historical-trade-row");
    expect(within(tradeRow).getByText("Buffalo Bills")).toBeInTheDocument();
    expect(within(tradeRow).getByText("Alex Owner")).toBeInTheDocument();
    expect(within(tradeRow).getByText("Casey Owner")).toBeInTheDocument();
    expect(within(tradeRow).getByText("25.0%")).toBeInTheDocument();
  });

  it("allows non-NFL historical Results for Calcutta I", async () => {
    const user = userEvent.setup();
    renderResults();

    await user.selectOptions(screen.getByTestId("select-calcutta-desktop"), "1");

    expect(await screen.findByTestId("historical-results-notice")).toBeInTheDocument();
    expect(screen.getByText("Blue Bloods")).toBeInTheDocument();
    expect(screen.queryByText(/reports are not available yet/i)).not.toBeInTheDocument();
  });

  it("keeps Calcutta VIII on the live Results command center", () => {
    renderResults();

    expect(screen.getByText("Results command center · 2025")).toBeInTheDocument();
    expect(screen.queryByTestId("historical-results-notice")).not.toBeInTheDocument();
  });
});