import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeasonProvider, useSeason } from "./useSeason";

const calcuttas = [
  { id: 13, name: "Calcutta XIII", sport: "MLB", year: 2026, seasonId: 13, isActive: true, isComplete: false },
  { id: 12, name: "Calcutta XII", sport: "NFL", year: 2026, seasonId: 12, isActive: true, isComplete: false },
  { id: 8, name: "Calcutta VIII", sport: "NFL", year: 2025, seasonId: 8, isActive: false, isComplete: true },
];

vi.mock("@workspace/api-client-react", () => ({
  useGetCalcuttas: () => ({ data: calcuttas, isLoading: false }),
}));

function Selection() {
  const { selectedCalcutta } = useSeason();
  return <span>{selectedCalcutta?.name}</span>;
}

function renderSelection() {
  render(<SeasonProvider><Selection /></SeasonProvider>);
}

describe("initial Calcutta selection", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to Calcutta XII instead of the newest Calcutta XIII", () => {
    renderSelection();
    expect(screen.getByText("Calcutta XII")).toBeTruthy();
  });

  it("keeps an explicitly saved Calcutta choice", () => {
    localStorage.setItem("nfl-auction-calcutta", "13");
    renderSelection();
    expect(screen.getByText("Calcutta XIII")).toBeTruthy();
  });

  it("keeps the legacy year selection", () => {
    localStorage.setItem("nfl-auction-season", "2025");
    renderSelection();
    expect(screen.getByText("Calcutta VIII")).toBeTruthy();
  });
});