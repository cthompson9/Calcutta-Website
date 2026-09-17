import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEspnNflScoreboardUrls,
  fetchEspnNflScoreboard,
} from "./nflEspnClient.ts";

test("builds the supported full regular-season scoreboard request", () => {
  const urls = buildEspnNflScoreboardUrls(2026);
  assert.equal(urls.length, 3);
  assert.match(urls[0], /^https:\/\/site\.web\.api\.espn\.com\/apis\/site\/v2\/sports\/football\/nfl\/scoreboard\?/);
  assert.match(urls[0], /dates=2026/);
  assert.match(urls[0], /seasontype=2/);
  assert.match(urls[0], /limit=1000/);
  assert.match(urls[1], /week=17/);
  assert.match(urls[2], /week=18/);
});

test("deduplicates events by ESPN id", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    const requested = String(input);
    const week17 = requested.includes("week=17");
    const week18 = requested.includes("week=18");
    return new Response(JSON.stringify({
      events: week18
        ? [{ id: "duplicate", date: "2026-12-01" }, ...Array.from({ length: 16 }, (_, i) => ({
          id: "duplicate",
          date: `2026-12-${String(i + 1).padStart(2, "0")}`,
          week: { number: 18 },
        }))]
        : week17
          ? [{ id: "duplicate", date: "2027-01-01" }, ...Array.from({ length: 15 }, (_, i) => ({
            id: `week17-${i + 1}`, date: `2027-01-${String(i + 1).padStart(2, "0")}`,
            week: { number: 17 },
          }))]
          : [{ id: "duplicate", date: "2026-09-01" }, ...Array.from({ length: 256 }, (_, i) => ({
            id: `event-${i + 1}`, date: `2026-09-${String((i % 30) + 1).padStart(2, "0")}`,
            week: { number: Math.floor(i / 16) + 1 },
          }))],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const payload = await fetchEspnNflScoreboard(2026);
    assert.equal(requestedUrls.length, 3);
    assert.equal(payload.events.length, 272);
    assert.deepEqual(
      [...new Set(payload.events.map((event) => event.week.number))].sort((a, b) => a - b),
      Array.from({ length: 18 }, (_, i) => i + 1),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("includes bounded ESPN error diagnostics for non-success responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("provider says invalid dates", { status: 400 });
  try {
    await assert.rejects(
      fetchEspnNflScoreboard(2026),
      /ESPN NFL scoreboard returned HTTP 400 .*provider says invalid dates/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});