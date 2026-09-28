import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SoldSaleAllocations } from "./SoldSaleAllocations";

describe("sold-lot allocation labels", () => {
  it("shows each owner's name and share when both belong to the same consortium", () => {
    render(
      <SoldSaleAllocations allocations={[
        { saleId: 1, consortiumId: 5, consortiumName: "Zack & Ezra", bidderId: 10, bidderName: "Zack Miller", share: "0.500000", cents: 35000 },
        { saleId: 1, consortiumId: 5, consortiumName: "Zack & Ezra", bidderId: 11, bidderName: "Ezra Pemstein", share: "0.500000", cents: 35000 },
      ]} />,
    );

    expect(screen.getByText("Zack Miller").parentElement).toHaveTextContent("50.00%");
    expect(screen.getByText("Ezra Pemstein").parentElement).toHaveTextContent("50.00%");
    expect(screen.queryByText("Zack & Ezra")).not.toBeInTheDocument();
  });
});