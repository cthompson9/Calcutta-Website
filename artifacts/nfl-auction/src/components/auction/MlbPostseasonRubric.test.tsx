import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MlbPostseasonRubric } from "./MlbPostseasonRubric";

describe("Calcutta XIII MLB postseason rubric", () => {
  it("shows per-win values, sweep bonuses, and the Wild Card bye award", () => {
    render(<MlbPostseasonRubric />);

    const rows = screen.getAllByRole("row").slice(1);
    const expected = [
      ["Wild Card round", "1 point", "+3 points"],
      ["Division Series", "2 points", "+5 points"],
      ["League Championship Series", "5 points", "+10 points"],
      ["World Series", "10 points", "+10 points"],
    ];
    expected.forEach(([name, win, sweep], index) => {
      expect(within(rows[index]).getByRole("rowheader")).toHaveTextContent(name);
      expect(within(rows[index]).getAllByRole("cell")[0]).toHaveTextContent(win);
      expect(within(rows[index]).getAllByRole("cell")[1]).toHaveTextContent(sweep);
    });
    expect(screen.getByText(/Wild Card bye:/).parentElement).toHaveTextContent(
      "+5 points for each team that earns a bye",
    );
  });
});