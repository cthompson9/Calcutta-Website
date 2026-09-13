import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildCanonicalRemainingSchedule } from "./mtmPipeline.ts";

const teams = new Map([
  [1, "BUF"],
  [2, "KC"],
]);

function event(overrides = {}) {
  return {
    id: 100,
    source: "espn",
    sourceEventId: "espn-100",
    week: 8,
    kickoffAt: new Date("2026-10-25T20:25:00.000Z"),
    sourceData: {
      kickoffTimeConfirmed: true,
      sourceUrl: "https://site.api.espn.com/complete-season",
      sourceFetchedAt: "2026-10-20T12:00:00.000Z",
    },
    updatedAt: new Date("2026-10-20T12:00:01.000Z"),
    homeTeamId: 1,
    awayTeamId: 2,
    ...overrides,
  };
}

test("canonical events reconstruct all remaining games without network access", () => {
  const rows = Array.from({ length: 270 }, (_, index) => event({
    id: index + 1,
    sourceEventId: `espn-${index + 1}`,
    week: Math.floor(index / 16) + 1,
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("weekly ESPN endpoint is unavailable");
  };
  try {
    const result = buildCanonicalRemainingSchedule(rows, teams);
    assert.equal(result.schedule.length, 270);
    assert.equal(result.provenance.length, 270);
    assert.deepEqual(result.schedule[0], {
      event_id: 1,
      home: "BUF",
      away: "KC",
      marquee: false,
      week: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("confirmed kickoff uses the existing marquee rule", () => {
  const sundayAfternoon = buildCanonicalRemainingSchedule([event()], teams);
  assert.equal(sundayAfternoon.schedule[0].marquee, false);

  const sundayNight = buildCanonicalRemainingSchedule([event({
    kickoffAt: new Date("2026-10-26T00:20:00.000Z"),
  })], teams);
  assert.equal(sundayNight.schedule[0].marquee, true);
});

test("unconfirmed kickoff is not marquee even when ESPN supplied a placeholder date", () => {
  const result = buildCanonicalRemainingSchedule([event({
    kickoffAt: null,
    sourceData: {
      kickoffTimeConfirmed: false,
      sourceUrl: "https://site.api.espn.com/complete-season",
      sourceFetchedAt: "2026-10-20T12:00:00.000Z",
    },
  })], teams);
  assert.equal(result.schedule[0].marquee, false);
});

test("later kickoff confirmation changes marquee classification", () => {
  const unconfirmed = buildCanonicalRemainingSchedule([event({
    kickoffAt: null,
    sourceData: { kickoffTimeConfirmed: false },
  })], teams);
  const confirmed = buildCanonicalRemainingSchedule([event({
    kickoffAt: new Date("2026-10-26T00:20:00.000Z"),
    sourceData: { kickoffTimeConfirmed: true },
  })], teams);
  assert.equal(unconfirmed.schedule[0].marquee, false);
  assert.equal(confirmed.schedule[0].marquee, true);
});

test("MTM export source contains no weekly ESPN schedule request", async () => {
  const source = await readFile(new URL("./mtmPipeline.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetchEspnRemainingSchedule/);
  assert.doesNotMatch(source, /url\.searchParams\.set\("week"/);
  assert.doesNotMatch(source, /seasontype.*2.*week/s);
});