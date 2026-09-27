import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AuctionSnapshot } from "@workspace/api-client-react";
import Trades from "./Trades";

let activeAuction: AuctionSnapshot | null = null;

vi.mock("@/hooks/useSeason", () => ({
  useSeason: () => ({
    year: 2026,
    selectedCalcutta: { id: 9, name: "Draft Pool", sport: "NFL", year: 2026 },
    setYear: vi.fn(),
  }),
}));
vi.mock("@/hooks/useAdminAccess", () => ({
  useAdminAccess: () => ({ adminKey: null, lock: vi.fn() }),
}));
vi.mock("@/hooks/useActiveAuction", () => ({
  useActiveAuction: () => ({ data: activeAuction, error: null }),
}));
vi.mock("@/hooks/useBacklinkBackShortcut", () => ({
  useBacklinkBackShortcut: () => undefined,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workspace/api-client-react")>(),
  useGetTrades: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  useGetTeams: () => ({ data: [{ id: 1, name: "Bills", bidAmount: 0 }] }),
  // The season-scoped bidder endpoint returns nobody before the first sale.
  useGetBidders: () => ({ data: [] }),
  useCreateTrade: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  activeAuction = null;
  window.history.replaceState(null, "", "/trades");
});

it("makes newly registered consortium owners available before any trades or sales", async () => {
  const user = userEvent.setup();
  const page = render(<Trades />);
  expect(screen.getByText("No trades recorded for 2026")).toBeInTheDocument();
  expect(screen.queryByTestId("auction-roster-summary")).not.toBeInTheDocument();

  activeAuction = {
    id: 40, calcuttaId: 9, status: "setup", revision: 0,
    currentLotId: null, createdAt: "2026-09-01T00:00:00Z", startedAt: null, completedAt: null,
    lots: [], sales: [], metrics: { poolSizeCents: 0, lotsSold: 0, totalLots: 0, averageSaleCents: null },
    consortia: [{ id: 50, auctionId: 40, displayName: "North Star", active: 1, owners: [
      { bidderId: 31, bidderName: "Alex", share: 0.6 },
      { bidderId: 32, bidderName: "Blair", share: 0.4 },
    ] }],
  };
  page.rerender(<Trades />);

  const roster = screen.getByTestId("auction-roster-summary");
  expect(within(roster).getByText("North Star")).toBeInTheDocument();
  expect(within(roster).getByText("Alex 60.00% · Blair 40.00%")).toBeInTheDocument();
  expect(screen.getByText("No trades recorded for 2026")).toBeInTheDocument();

  await user.click(screen.getByTestId("button-submit-trade"));
  const [, seller, buyer] = screen.getAllByRole("combobox");
  expect(within(seller).getByRole("option", { name: "North Star — Alex" })).toHaveValue("31");
  expect(within(buyer).getByRole("option", { name: "North Star — Blair" })).toHaveValue("32");
  expect(screen.getByText(/Trades are recorded against owners, not the consortium itself/)).toBeInTheDocument();
});