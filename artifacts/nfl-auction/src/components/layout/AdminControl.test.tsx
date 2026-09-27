import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAccessProvider, useAdminAccess } from "@/hooks/useAdminAccess";
import { AdminControl } from "./AdminControl";

function Tabs() {
  const { adminKey } = useAdminAccess();
  return (
    <>
      <div data-testid="auction-access">{adminKey ? "Auction unlocked" : "Auction locked"}</div>
      <div data-testid="analysis-access">{adminKey ? "Analysis unlocked" : "Analysis locked"}</div>
      <div data-testid="trades-access">{adminKey ? "Trades unlocked" : "Trades locked"}</div>
    </>
  );
}

function renderControls() {
  return render(
    <AdminAccessProvider>
      <AdminControl />
      <AdminControl mobile />
      <Tabs />
    </AdminAccessProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("shared admin access", () => {
  it("validates once, unlocks all tabs, and locks them together from mobile", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const view = renderControls();

    fireEvent.click(screen.getByTestId("button-admin-sidebar"));
    fireEvent.change(screen.getByTestId("input-admin-key-desktop"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByTestId("button-unlock-admin-desktop"));
    await waitFor(() => expect(screen.getByTestId("analysis-access").textContent).toBe("Analysis unlocked"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/validate", {
      headers: { Authorization: "Bearer test-key" },
    });
    expect(screen.getByTestId("auction-access").textContent).toBe("Auction unlocked");
    expect(screen.getByTestId("trades-access").textContent).toBe("Trades unlocked");

    fireEvent.click(screen.getByTestId("button-admin-mobile"));
    expect(screen.getByTestId("auction-access").textContent).toBe("Auction locked");
    expect(screen.getByTestId("analysis-access").textContent).toBe("Analysis locked");
    expect(screen.getByTestId("trades-access").textContent).toBe("Trades locked");
    view.unmount();
    renderControls();
    expect(screen.getByTestId("analysis-access").textContent).toBe("Analysis locked");
  });

  it("does not unlock any tab when the key is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    renderControls();
    fireEvent.click(screen.getByTestId("button-admin-mobile"));
    fireEvent.change(screen.getByTestId("input-admin-key-mobile"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByTestId("button-unlock-admin-mobile"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid admin key");
    expect(screen.getByTestId("auction-access").textContent).toBe("Auction locked");
    expect(screen.getByTestId("analysis-access").textContent).toBe("Analysis locked");
    expect(screen.getByTestId("trades-access").textContent).toBe("Trades locked");
  });
});