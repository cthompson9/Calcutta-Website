import { describe, expect, it } from "vitest";
import { nflDisplayWeek } from "./nflDisplayWeek";

describe("nflDisplayWeek", () => {
  it("starts 2026 Week 1 on September 13 in New York", () => {
    expect(nflDisplayWeek(new Date("2026-09-13T03:59:59.000Z"))).toBe(0);
    expect(nflDisplayWeek(new Date("2026-09-13T04:00:00.000Z"))).toBe(1);
  });

  it("advances the display week every Sunday", () => {
    expect(nflDisplayWeek(new Date("2026-09-19T23:59:59-04:00"))).toBe(1);
    expect(nflDisplayWeek(new Date("2026-09-20T00:00:00-04:00"))).toBe(2);
    expect(nflDisplayWeek(new Date("2026-09-27T12:00:00-04:00"))).toBe(3);
  });
});