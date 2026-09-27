import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AuctionSnapshot } from "@workspace/api-client-react";
import MtmTracker from "./MtmTracker";

const auction: AuctionSnapshot = {
  id: 40, calcuttaId: 9, status: "setup", revision: 0,
  currentLotId: null, createdAt: "2026-09-01T00:00:00Z", startedAt: null, completedAt: null,
  lots: [], sales: [], metrics: { poolSizeCents: 0, lotsSold: 0, totalLots: 0, averageSaleCents: null },
  consortia: [{ id: 50, auctionId: 40, displayName: "Draft Analysts", active: 1, owners: [
    { bidderId: 60, bidderName: "Riley", share: 1 },
  ] }],
};

vi.mock("@/hooks/useSeason", () => ({
  useSeason: () => ({ selectedCalcutta: { id: 9, name: "Draft Pool", sport: "NCAAM", year: 2026 } }),
}));
vi.mock("@/hooks/useActiveAuction", () => ({
  useActiveAuction: () => ({ data: auction, error: null }),
}));

it("shows selected auction members in Analysis even without a valuation", () => {
  render(<MtmTracker />);
  const roster = screen.getByTestId("auction-roster-summary");
  expect(within(roster).getByText("Draft Analysts")).toBeInTheDocument();
  expect(within(roster).getByText("Riley 100.00%")).toBeInTheDocument();
  expect(screen.getByText("No team values available")).toBeInTheDocument();
});