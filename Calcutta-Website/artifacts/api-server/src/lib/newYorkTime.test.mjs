import assert from "node:assert/strict";
import test from "node:test";

const { todayInNewYork, currentYearInNewYork } = await import("./newYorkTime.ts");

test("New York calendar date remains on the prior day before Eastern midnight", () => {
  const utcLateEvening = new Date("2026-08-22T03:30:00.000Z");
  assert.equal(todayInNewYork(utcLateEvening), "2026-08-21");
  assert.equal(currentYearInNewYork(utcLateEvening), 2026);
});

test("New York calendar date advances after Eastern midnight", () => {
  const utcEarlyMorning = new Date("2026-08-22T04:30:00.000Z");
  assert.equal(todayInNewYork(utcEarlyMorning), "2026-08-22");
});