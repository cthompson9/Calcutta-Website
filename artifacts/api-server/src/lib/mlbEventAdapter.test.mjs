import assert from "node:assert/strict";
import test from "node:test";
import { buildEspnMlbDateUrl, fetchEspnMlbForDate } from "./mlbEspnClient.ts";
import { parseEspnMlbPostseason } from "./mlbEventAdapter.ts";

function game(overrides = {}) {
  return {
    id: "401809252", date: "2025-10-01T17:00Z",
    season: { year: 2025, type: 3 },
    competitions: [{
      notes: [{ headline: "ALWC - Game 2" }],
      series: { type: "playoff", totalCompetitions: 3 },
      status: { type: { name: "STATUS_FINAL", state: "post", completed: true } },
      competitors: [
        { homeAway: "home", score: "6", winner: true, team: { id: "5", displayName: "Cleveland Guardians" } },
        { homeAway: "away", score: "1", winner: false, team: { id: "6", displayName: "Detroit Tigers" } },
      ],
    }],
    ...overrides,
  };
}
function payload(events) {
  return { events, provenance: {
    sourceUrl: buildEspnMlbDateUrl("20251001"), fetchedAt: "2025-10-01T21:00:00Z", requestedDate: "20251001",
  } };
}
const parse = (events) => parseEspnMlbPostseason(payload(events), 2025);

test("MLB uses validated daily URLs, not unreliable season/range filtering", () => {
  assert.match(buildEspnMlbDateUrl("20251001"), /dates=20251001&limit=100$/);
  for (const date of ["20250230", "20251301", "20251001-20251003", "2025", "2025101"]) {
    assert.throws(() => buildEspnMlbDateUrl(date));
  }
});

test("daily client retains provenance and rejects missing events or truncated responses", async () => {
  const response = (value) => async () => new Response(JSON.stringify(value));
  const result = await fetchEspnMlbForDate("20251001", response({ events: [game()] }));
  assert.equal(result.events[0].id, "401809252");
  assert.equal(result.provenance.requestedDate, "20251001");
  assert.match(result.provenance.fetchedAt, /^\d{4}-/);
  await assert.rejects(fetchEspnMlbForDate("20251001", response({ error: "not a scoreboard" })));
  await assert.rejects(fetchEspnMlbForDate("20251001", response({ events: Array(100).fill(game()) })), /truncated/);
  await assert.rejects(fetchEspnMlbForDate("20251001", async () => new Response("", { status: 503 })), /HTTP 503/);
});

test("preserves final evidence and skips other years and non-postseason games", () => {
  const result = parse([game(), game({ id: "regular", season: { year: 2025, type: 2 } }),
    game({ id: "other-year", season: { year: 2026, type: 3 } })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].homeScore, 6);
  assert.equal(result[0].awayScore, 1);
  assert.equal(result[0].period, 1);
  assert.equal(result[0].gameNumber, 2);
  assert.equal(result[0].eventDate, "2025-10-01");
  assert.deepEqual(result[0].rawProviderData, game());
});

test("retains repeated same-matchup games and stable series identity across home-field changes", () => {
  const one = game();
  const two = structuredClone(one);
  two.id = "second-game";
  two.competitions[0].notes[0].headline = "ALWC - Game 3";
  two.competitions[0].competitors.forEach((c) => { c.homeAway = c.homeAway === "home" ? "away" : "home"; });
  const result = parse([one, two]);
  assert.equal(result.length, 2);
  assert.equal(result[0].seriesKey, result[1].seriesKey);
  assert.notEqual(result[0].providerEventId, result[1].providerEventId);
  assert.throws(() => parse([one, one]), /duplicate event/);
});

for (const [headline, bestOf, period] of [
  ["NLWC - Game 3", 3, 1], ["ALDS - Game 5", 5, 2],
  ["NLCS - Game 7", 7, 3], ["WS - Game 7", 7, 4], ["World Series - Game 1", 7, 4],
]) {
  test(`maps ${headline} to explicit round and series length`, () => {
    const event = game();
    event.competitions[0].notes = [{ headline }];
    event.competitions[0].series.totalCompetitions = bestOf;
    const [result] = parse([event]);
    assert.equal(result.bestOf, bestOf);
    assert.equal(result.period, period);
  });
}

test("invalid round, game number, length, scores or winner flags fail closed", () => {
  for (const change of [
    (c) => { c.notes = []; },
    (c) => { c.notes[0].headline = "ALWC - Game 4"; },
    (c) => { c.series.totalCompetitions = 7; },
    (c) => { c.competitors[0].score = "6 runs"; },
    (c) => { c.competitors[1].score = "6"; },
    (c) => { c.competitors[0].winner = false; },
    (c) => { c.status.type = { state: "post", completed: false }; },
  ]) {
    const event = game();
    change(event.competitions[0]);
    assert.throws(() => parse([event]));
  }
});

for (const [name, state, completed, expected] of [
  ["STATUS_POSTPONED", "pre", false, "postponed"],
  ["STATUS_SUSPENDED", "in", false, "suspended"],
  ["STATUS_CANCELED", "post", true, "cancelled"],
  ["STATUS_UNNECESSARY", "post", true, "cancelled"],
  ["STATUS_IN_PROGRESS", "in", false, "in_progress"],
  ["STATUS_SCHEDULED", "pre", false, "scheduled"],
]) {
  test(`${name} is not final evidence and cannot earn points`, () => {
    const event = game();
    event.competitions[0].status.type = { name, state, completed };
    const [result] = parse([event]);
    assert.equal(result.status, expected);
    assert.equal(result.homeScore, null);
    assert.equal(result.awayScore, null);
  });
}

test("reschedule and corrected final keep the provider identity; midnight uses New York date", () => {
  const original = parse([game()])[0];
  const corrected = game({ date: "2025-10-02T01:00:00Z" });
  corrected.competitions[0].timeValid = false;
  corrected.competitions[0].competitors[0].score = "7";
  const [updated] = parse([corrected]);
  assert.equal(updated.providerEventId, original.providerEventId);
  assert.equal(updated.seriesKey, original.seriesKey);
  assert.equal(updated.homeScore, 7);
  assert.equal(updated.eventDate, "2025-10-01");
  assert.equal(updated.kickoffAt, null);
});
