import { describe, expect, it } from "vitest";
import { validateCalcuttaForm } from "./CreateCalcuttaDialog";
import { formatCalcuttaLabel } from "@/hooks/useSeason";

describe("Calcutta creation form validation", () => {
  const valid = {
    sport: "CFB",
    year: "2027",
    lots: "Alpha, Beta",
    rubric: [{ event: "Champion", value: "100" }],
    scoringFormat: "percentage" as const,
  };

  it("requires a sport and a four-digit year", () => {
    expect(validateCalcuttaForm({ ...valid, sport: " " })).toBe("Sport is required.");
    expect(validateCalcuttaForm({ ...valid, year: "27" })).toBe("Enter a valid four-digit year.");
  });

  it("requires at least one lot and a complete rubric", () => {
    expect(validateCalcuttaForm({ ...valid, lots: " , " })).toBe("Enter at least one lot.");
    expect(validateCalcuttaForm({ ...valid, rubric: [{ event: "", value: "100" }] })).toContain("Each rubric event");
  });

  it("requires percentage rubric values to total exactly 100", () => {
    expect(validateCalcuttaForm({ ...valid, rubric: [{ event: "Champion", value: "99.9" }] })).toContain("must total exactly 100%");
    expect(validateCalcuttaForm({ ...valid, rubric: [{ event: "Champion", value: "40" }, { event: "Runner-up", value: "60" }] })).toBeNull();
  });

  it("allows point rubrics with non-negative numeric values", () => {
    expect(validateCalcuttaForm({ ...valid, scoringFormat: "points", rubric: [{ event: "Wins", value: "1" }] })).toBeNull();
    expect(validateCalcuttaForm({ ...valid, scoringFormat: "points", rubric: [{ event: "Wins", value: "0" }] })).toContain("greater than zero");
    expect(validateCalcuttaForm({ ...valid, scoringFormat: "points", rubric: [{ event: "Wins", value: "-1" }] })).toContain("non-negative");
  });
});

describe("Calcutta selector labels", () => {
  it("does not append a duplicate sport/year suffix to a full generated name", () => {
    expect(formatCalcuttaLabel({
      name: "Calcutta XIII - MLB Playoffs 2026",
      sport: "MLB",
      year: 2026,
    })).toBe("Calcutta XIII - MLB Playoffs 2026");
  });

  it("adds sport and year to a short legacy selector name", () => {
    expect(formatCalcuttaLabel({ name: "Calcutta XII", sport: "NFL", year: 2026 }))
      .toBe("Calcutta XII - NFL 2026");
  });
});