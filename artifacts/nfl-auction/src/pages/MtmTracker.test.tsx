import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MtmGameEvSwing, MtmQualityExposure, MtmTeamEvSwing } from "@workspace/api-client-react";
import {
  AdminMtmDiagnostics,
  MtmEvidenceInspector,
  NetPayoutHistoryChart,
  PipelineFailureNotice,
  MtmQualitySummary,
  UpcomingEvSwings,
  visiblePipelineHistory,
} from "./MtmTracker";
import { momentumBaselineNetPayout } from "@/lib/mtmMomentum";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));


vi.mock("@/hooks/useMeasure", () => ({
  useMeasure: () => ({ ref: { current: null }, width: 820, height: 390 }),
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

type EvidenceAttempt = {
  id: number;
  status: "ok" | "failed" | "running";
  trigger: "scheduled" | "manual";
  asOf: string;
  createdAt: string;
  methodVersion: string;
  error: string | null;
  quoteCount: number;
  deletable: boolean;
  deleteBlockedReason: string | null;
};

function evidenceAttempt(
  id: number,
  overrides: Partial<EvidenceAttempt> = {},
): EvidenceAttempt {
  return {
    id,
    status: "ok",
    trigger: "manual",
    asOf: "2026-09-12T12:00:00.000Z",
    createdAt: `2026-09-12T12:${String(id).padStart(2, "0")}:00.000Z`,
    methodVersion: "mtm-v3",
    error: null,
    quoteCount: 2,
    deletable: true,
    deleteBlockedReason: null,
    ...overrides,
  };
}

function evidenceResponse(attempts: EvidenceAttempt[], selectedId: number) {
  const selected = attempts.find((attempt) => attempt.id === selectedId);
  return {
    attempts,
    selectedAttempt: selected ? {
      ...selected,
      diagnostics: null,
      receivedMarkets: [],
      failedSources: [],
      eliminationEvidence: [] as Array<{
        ticker: string;
        team: string;
        outcome: string;
        bid: number | null;
        ask: number | null;
        last: number | null;
        confidenceTier: "settled_fact" | "strong_active_book" | "verified_trade" | "last_context" | "active_book";
        fittedProbability: number | null;
        intervalMiss: number | null;
        nearPublicationCeiling: boolean;
      }>,
      quotes: [],
    } : null,
  };
}

function renderEvidenceInspector(
  onDeleted = vi.fn(async () => undefined),
  manualRun: React.ComponentProps<typeof MtmEvidenceInspector>["manualRun"] = null,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MtmEvidenceInspector
        year={2026}
        calcuttaId={7}
        adminKey="test-admin-key"
        manualRun={manualRun}
        onDeleted={onDeleted}
      />
    </QueryClientProvider>,
  );
  return { onDeleted };
}

async function selectPriorAttempt(user: ReturnType<typeof userEvent.setup>) {
  const attemptButtons = await screen.findAllByRole("button", { name: /Sep 12.*2 quotes/i });
  await user.click(attemptButtons.at(-1)!);
  await waitFor(() => expect(screen.getByRole("heading", { name: /^Attempt #11/ })).toBeInTheDocument());
}

describe("MtmEvidenceInspector deletion", () => {
  it("renders persisted elimination confidence and highlights a near-ceiling active-book miss", async () => {
    const attempt = evidenceAttempt(12);
    const payload = evidenceResponse([attempt], attempt.id);
    payload.selectedAttempt!.eliminationEvidence = [{
      ticker: "KXNFLSTAGEOFELIM-27BUF-DIV",
      team: "BUF",
      outcome: "divisional",
      bid: 0.25,
      ask: 0.3,
      last: 0.28,
      confidenceTier: "strong_active_book",
      fittedProbability: 0.38,
      intervalMiss: 0.08,
      nearPublicationCeiling: true,
    }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }),
    );

    renderEvidenceInspector();

    expect(await screen.findByText("Strong active book")).toBeInTheDocument();
    const row = screen.getByText("Strong active book").closest("tr");
    expect(row).toHaveClass("bg-amber-500/15");
    expect(within(row!).getByText("38.0%")).toBeInTheDocument();
    expect(within(row!).getByText("8.0%")).toBeInTheDocument();
  });

  it("shows a timestamped pending audit entry while recalculation is running", async () => {
    const existing = evidenceAttempt(12);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(evidenceResponse([existing], existing.id)), { status: 200 }),
    );

    renderEvidenceInspector(
      undefined,
      {
        running: true,
        startedAt: "2026-09-14T18:30:00.000Z",
        completedAt: null,
        error: null,
        currentSnapshotId: null,
      },
    );

    expect(await screen.findByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText(/Sep 14/i)).toBeInTheDocument();
  });

  it("renders a durable running attempt without presenting it as a failure", async () => {
    const running = evidenceAttempt(101, {
      status: "running",
      error: null,
      deletable: false,
      deleteBlockedReason: "This MTM update is still running.",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(evidenceResponse([running], running.id)), { status: 200 }),
    );

    renderEvidenceInspector();

    expect(await screen.findByRole("heading", { name: /^Attempt #101/ })).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Exception")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete update" })).toBeDisabled();
    expect(screen.getByText("This MTM update is still running.")).toBeInTheDocument();
  });

  it("shows the current published update as disabled with its explanation", async () => {
    const current = evidenceAttempt(12, {
      deletable: false,
      deleteBlockedReason: "The current published update cannot be deleted.",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(evidenceResponse([current], current.id)), { status: 200 }),
    );

    renderEvidenceInspector();

    expect(await screen.findByRole("heading", { name: /^Attempt #12/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete update" })).toBeDisabled();
    expect(screen.getByText("The current published update cannot be deleted.")).toBeInTheDocument();
  });

  it("requires exact typed confirmation and refreshes history plus dependent MTM data after deletion", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    const current = evidenceAttempt(12, {
      deletable: false,
      deleteBlockedReason: "The current published update cannot be deleted.",
    });
    const prior = evidenceAttempt(11);
    let deleted = false;
    let requestedDeletedAttemptAfterDeletion = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        deleted = true;
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      const selectedId = new URL(url, "http://localhost").searchParams.get("attemptId");
      if (deleted && selectedId === String(prior.id)) {
        requestedDeletedAttemptAfterDeletion = true;
        return new Response(JSON.stringify({ error: "MTM update was not found." }), { status: 404 });
      }
      const attempts = deleted ? [current] : [current, prior];
      return new Response(
        JSON.stringify(evidenceResponse(attempts, Number(selectedId) || current.id)),
        { status: 200 },
      );
    });
    const { onDeleted } = renderEvidenceInspector();

    await selectPriorAttempt(user);
    await user.click(screen.getByRole("button", { name: "Delete update" }));

    const confirmation = screen.getByLabelText("Type DELETE 11 to confirm");
    const deleteButton = screen.getByRole("button", { name: "Delete permanently" });
    expect(deleteButton).toBeDisabled();
    await user.type(confirmation, "delete 11");
    expect(deleteButton).toBeDisabled();
    await user.clear(confirmation);
    await user.type(confirmation, "DELETE 11");
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^Attempt #12/ })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: /^Attempt #11/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mtm/pipeline/attempts/11",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(requestedDeletedAttemptAfterDeletion).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/mtm/pipeline/evidence")).length)
      .toBeGreaterThanOrEqual(3);
  });

  it("keeps an API error visible through the toast and leaves the selected update in place", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    const current = evidenceAttempt(12, {
      deletable: false,
      deleteBlockedReason: "The current published update cannot be deleted.",
    });
    const prior = evidenceAttempt(11);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: "Deletion was rejected by the API." }), { status: 409 });
      }
      const selectedId = new URL(String(input), "http://localhost").searchParams.get("attemptId");
      return new Response(
        JSON.stringify(evidenceResponse([current, prior], Number(selectedId) || current.id)),
        { status: 200 },
      );
    });
    const { onDeleted } = renderEvidenceInspector();

    await selectPriorAttempt(user);
    await user.click(screen.getByRole("button", { name: "Delete update" }));
    await user.type(screen.getByLabelText("Type DELETE 11 to confirm"), "DELETE 11");
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Deletion was rejected by the API."));
    expect(screen.getByRole("heading", { name: /^Attempt #11/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Type DELETE 11 to confirm")).toHaveValue("DELETE 11");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("momentumBaselineNetPayout", () => {
  it("uses the refresh closest to seven days before the latest refresh", () => {
    expect(momentumBaselineNetPayout([
      { asOf: "2026-09-01T12:00:00.000Z", netPayout: 10 },
      { asOf: "2026-09-04T12:00:00.000Z", netPayout: 20 },
      { asOf: "2026-09-08T11:00:00.000Z", netPayout: 30 },
      { asOf: "2026-09-10T12:00:00.000Z", netPayout: 40 },
    ])).toBe(20);
  });

  it("prefers the earlier refresh when two refreshes are equally close", () => {
    expect(momentumBaselineNetPayout([
      { asOf: "2026-09-02T12:00:00.000Z", netPayout: 10 },
      { asOf: "2026-09-04T12:00:00.000Z", netPayout: 20 },
      { asOf: "2026-09-10T12:00:00.000Z", netPayout: 40 },
    ])).toBe(10);
  });

  it("uses the earliest mark when multiple refreshes span less than seven days", () => {
    expect(momentumBaselineNetPayout([
      { asOf: "2026-09-10T12:00:00.000Z", netPayout: 10 },
      { asOf: "2026-09-11T12:00:00.000Z", netPayout: 18 },
      { asOf: "2026-09-12T12:00:00.000Z", netPayout: 22 },
      { asOf: "2026-09-13T12:00:00.000Z", netPayout: 25 },
    ])).toBe(10);
  });

  it("orders refreshes by timestamp before choosing the baseline", () => {
    expect(momentumBaselineNetPayout([
      { asOf: "2026-09-13T12:00:00.000Z", netPayout: 30 },
      { asOf: "2026-09-01T12:00:00.000Z", netPayout: 5 },
      { asOf: "2026-09-06T12:00:00.000Z", netPayout: 15 },
    ])).toBe(15);
  });
});

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
  it("starts with all teams unselected and selects teams only from the chart", async () => {
    const user = userEvent.setup();
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

    expect(screen.getByRole("button", { name: "Even" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compressed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Season" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 3 Weeks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Even" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Compressed" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("Selected teams")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Buffalo Bills" })).not.toBeInTheDocument();
    expect(screen.queryByText("BUF")).not.toBeInTheDocument();
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    expect(screen.getByTestId("net-payout-background-path-7")).toHaveAttribute(
      "stroke",
      "color-mix(in srgb, #00338D 24%, hsl(var(--background)))",
    );
    expect(screen.getByTestId("net-payout-background-path-7")).not.toHaveAttribute("opacity");

    const svg = screen.getByTestId("net-payout-chart");
    fireEvent.pointerDown(svg, { clientX: 82, clientY: 329, pointerId: 1, isPrimary: true });
    fireEvent.pointerUp(svg, { clientX: 82, clientY: 329, pointerId: 1, isPrimary: true });

    expect(screen.getByLabelText("Selected teams")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Buffalo Bills" })).toBeInTheDocument();
    expect(screen.getByText("BUF")).toBeInTheDocument();
    const path = screen.getByTestId("net-payout-path-7");
    expect(path.getAttribute("d")).toMatch(/^M[^L]+L/);
    expect(path).toHaveAttribute("stroke", "#00338D");
    expect(container.querySelectorAll("circle").length).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole("button", { name: "Remove Buffalo Bills" }));
    fireEvent.pointerLeave(svg);

    expect(screen.queryByLabelText("Selected teams")).not.toBeInTheDocument();
    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });

  it("scrubs without pinning on drag and supports keyboard clearing", () => {
    render(
      <NetPayoutHistoryChart
        valuations={[{
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
            { snapshotId: 101, label: "Week 0", asOf: "2026-08-25T12:00:00.000Z", expectedPayout: 1400, auctionPrice: 1500, netPayout: -100 },
            { snapshotId: 102, label: "Week 1", asOf: "2026-09-13T12:00:00.000Z", expectedPayout: 1600, auctionPrice: 1500, netPayout: 100 },
          ],
        }]}
      />,
    );

    const svg = screen.getByTestId("net-payout-chart");
    fireEvent.pointerDown(svg, { clientX: 82, clientY: 329, pointerId: 1, isPrimary: true });
    fireEvent.pointerMove(svg, { clientX: 150, clientY: 250, pointerId: 1, isPrimary: true });
    fireEvent.pointerUp(svg, { clientX: 150, clientY: 250, pointerId: 1, isPrimary: true });

    expect(screen.queryByLabelText("Selected teams")).not.toBeInTheDocument();
    expect(screen.getByTestId("net-payout-crosshair")).toBeInTheDocument();

    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(screen.getByTestId("net-payout-crosshair")).toBeInTheDocument();
    fireEvent.keyDown(svg, { key: "Escape" });
    expect(screen.queryByTestId("net-payout-crosshair")).not.toBeInTheDocument();
  });

  it("keeps the active readout after a touch interaction ends", () => {
    render(
      <NetPayoutHistoryChart
        valuations={[{
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
            { snapshotId: 101, label: "Week 1", asOf: "2026-09-13T12:00:00.000Z", expectedPayout: 1600, auctionPrice: 1500, netPayout: 100 },
          ],
        }]}
      />,
    );

    const svg = screen.getByTestId("net-payout-chart");
    fireEvent.pointerDown(svg, { clientX: 419, clientY: 41, pointerId: 2, pointerType: "touch", isPrimary: true });
    fireEvent.pointerUp(svg, { clientX: 419, clientY: 41, pointerId: 2, pointerType: "touch", isPrimary: true });
    fireEvent.pointerLeave(svg, { pointerType: "touch" });

    expect(screen.getByTestId("net-payout-readout")).toBeInTheDocument();
  });

  it("limits Last 3 Weeks to the 21 days ending at the latest chart timestamp", async () => {
    const user = userEvent.setup();
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
                label: "Auction",
                asOf: "2026-08-01T12:00:00.000Z",
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
                label: "Week 3",
                asOf: "2026-09-22T12:00:00.000Z",
                expectedPayout: 1650,
                auctionPrice: 1500,
                netPayout: 150,
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Last 3 Weeks" }));

    const svg = screen.getByTestId("net-payout-chart");
    fireEvent.pointerDown(svg, { clientX: 756, clientY: 41, pointerId: 1, isPrimary: true });
    fireEvent.pointerUp(svg, { clientX: 756, clientY: 41, pointerId: 1, isPrimary: true });

    const path = screen.getByTestId("net-payout-path-7");
    expect(path.getAttribute("d")?.match(/[ML]/g)).toHaveLength(2);
    expect(screen.queryByText("Auction")).not.toBeInTheDocument();
  });
});

describe("UpcomingEvSwings", () => {
  it("defaults to the current week and lets users add either of the next two weeks", async () => {
    const user = userEvent.setup();
    render(<UpcomingEvSwings games={[
      game(6, 6, "Late Away", "Late Home"),
      game(4, 4, "Zulu Away", "Home Four"),
      game(3, 3, "Bills", "Jets"),
      game(5, 4, "Alpha Away", "Other Home"),
      game(7, 5, "Week Five Away", "Week Five Home"),
    ]} />);

    expect(screen.queryByText("Late Away @ Late Home")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Week 3" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Week 4" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Week 5" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("group", { name: "Week 3" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Week 4" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Week 5" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Week 4" }));
    await user.click(screen.getByRole("button", { name: "Week 5" }));

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

  it("combines bidders mapped to the same consortium into one exposure row", async () => {
    const user = userEvent.setup();
    const consortiumGame = game(9, 9, "Bills", "Jets");
    const firstHolding = consortiumGame.owners[0].holdings[0];
    consortiumGame.owners = [
      {
        bidderId: 1,
        bidderName: "Alice",
        holdings: [{
          ...firstHolding,
          signedShare: -0.25,
          benefitOfWin: -7.5,
          costOfLoss: -6.25,
          totalEvSwing: -13.75,
        }],
      },
      {
        bidderId: 2,
        bidderName: "Bob",
        holdings: [{
          ...firstHolding,
          signedShare: -0.15,
          benefitOfWin: -2.5,
          costOfLoss: -3.75,
          totalEvSwing: -16.25,
        }],
      },
    ];
    render(
      <UpcomingEvSwings
        games={[consortiumGame]}
        consortiumByName={new Map([
          ["Alice", "Alpha Consortium"],
          ["Bob", "Alpha Consortium"],
        ])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "By Owner" }));
    expect(screen.getAllByTestId("ev-swing-owner-group")).toHaveLength(1);
    expect(screen.getByTestId("ev-swing-owner-group")).toHaveTextContent("Alpha Consortium");
    expect(screen.getAllByTestId("ev-swing-owner")).toHaveLength(1);
    expect(screen.getByTestId("ev-swing-owner")).toHaveTextContent("−$30 swing");
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
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

    const ownerFilter = screen.getByRole("searchbox", { name: "Filter consortiums and teams" });
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

describe("MtmQualitySummary", () => {
  const quality: MtmQualityExposure = {
    status: "stale-pending",
    reasons: ["Unincorporated finalized games require recalculation."],
    actualsCutoff: "2026-09-12T16:00:00.000Z",
    evidenceCutoff: "2026-09-12T15:00:00.000Z",
    markTimestamp: "2026-09-11T20:00:00.000Z",
    priorVersion: 14,
    priorModelVersion: "mtm-v1",
    modelVersion: "mtm-v1",
    policyVersion: "mtm-evidence-v1",
    excludedEvidence: [{ id: "BUF", reason: "wide market" }],
    dominantEvidence: { id: "KC", weight: 0.4 },
    finalEffectiveSampleSize: 1200,
    finalMaxWeight: 0.2,
    precision: 4,
    publicationDecision: "published",
    prefitDiagnostics: {
      label: "Prefit diagnostics (informational; not the publication decision)",
      marketCalibration: {},
      available: true,
    },
  };

  it("labels pending quality and retains audit timestamps and prefit warning", () => {
    render(<MtmQualitySummary quality={quality} />);
    expect(screen.getByTestId("mtm-quality-status")).toHaveTextContent("Stale · pending recalculation");
    expect(screen.getByTestId("mtm-quality-summary")).toHaveTextContent("Actuals cutoff");
    expect(screen.getByTestId("mtm-quality-summary")).toHaveTextContent("Final ESS: 1200.0");
    expect(screen.getByTestId("mtm-quality-summary")).toHaveTextContent("Prefit diagnostics");
    expect(screen.getByTestId("mtm-quality-summary")).toHaveTextContent("Unincorporated finalized games");
  });
});

describe("AdminMtmDiagnostics", () => {
  const mark = {
    stale: true,
    selectionReason: "Internal selection detail",
    provisionalSuppressionReason: "Internal suppression detail",
  } as Parameters<typeof AdminMtmDiagnostics>[0]["mark"];

  it("hides mark quality and staleness details from standard users", () => {
    render(
      <AdminMtmDiagnostics
        isAdmin={false}
        quality={{ status: "unavailable", reasons: ["Internal audit detail"] } as MtmQualityExposure}
        status={null}
        mark={mark}
      />,
    );

    expect(screen.queryByText("Mark quality")).not.toBeInTheDocument();
    expect(screen.queryByText("The current mark is stale.")).not.toBeInTheDocument();
    expect(screen.queryByText("Internal selection detail")).not.toBeInTheDocument();
  });

  it("shows mark quality and staleness details to validated admins", () => {
    render(
      <AdminMtmDiagnostics
        isAdmin
        quality={null}
        status={null}
        mark={mark}
      />,
    );

    expect(screen.getByText("The current mark is stale.")).toBeInTheDocument();
    expect(screen.getByText("Internal selection detail")).toBeInTheDocument();
    expect(screen.getByText("Internal suppression detail")).toBeInTheDocument();
  });
});

describe("visiblePipelineHistory", () => {
  it("keeps archived points visible while excluding an unaudited current snapshot", () => {
    const status = {
      valuations: [{
        entryId: 1,
        teamId: 10,
        teamName: "Buffalo Bills",
        expectedPoints: "0",
        expectedPayout: "0",
        previousExpectedPayout: null,
        auctionPrice: "100",
        mtmMultiple: null,
        owners: [],
        history: [
          { snapshotId: 9, label: "Week 1", asOf: "2026-09-07T12:00:00.000Z", expectedPayout: 120, auctionPrice: 100, netPayout: 20 },
          { snapshotId: 15, label: "Week 2", asOf: "2026-09-14T12:00:00.000Z", expectedPayout: 140, auctionPrice: 100, netPayout: 40 },
        ],
      }],
    } as unknown as Parameters<typeof visiblePipelineHistory>[0];
    const valuation = {
      available: false,
      mark: { sourceSnapshotId: 15 },
      teams: [],
    } as unknown as Parameters<typeof visiblePipelineHistory>[1];

    expect(visiblePipelineHistory(status, valuation)[0]?.history.map((point) => point.snapshotId))
      .toEqual([9]);
  });

  it("keeps the archived source point when unavailable valuation rows are supplied for display", () => {
    const status = {
      valuations: [{
        entryId: 1,
        teamId: 10,
        teamName: "Buffalo Bills",
        expectedPoints: "0",
        expectedPayout: "140",
        previousExpectedPayout: null,
        auctionPrice: "100",
        mtmMultiple: "1.4",
        owners: [],
        history: [
          { snapshotId: 9, label: "Week 1", asOf: "2026-09-07T12:00:00.000Z", expectedPayout: 120, auctionPrice: 100, netPayout: 20 },
          { snapshotId: 15, label: "Week 2", asOf: "2026-09-14T12:00:00.000Z", expectedPayout: 140, auctionPrice: 100, netPayout: 40 },
        ],
      }],
    } as unknown as Parameters<typeof visiblePipelineHistory>[0];
    const valuation = {
      available: false,
      mark: { sourceSnapshotId: 15 },
      teams: [{ teamId: 10 }],
    } as Parameters<typeof visiblePipelineHistory>[1];

    expect(visiblePipelineHistory(status, valuation)[0]?.history.map((point) => point.snapshotId))
      .toEqual([9, 15]);
  });
});