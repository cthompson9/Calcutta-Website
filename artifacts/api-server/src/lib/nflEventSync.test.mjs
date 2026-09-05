import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEspnRegularSeasonEvents,
  validateEspnRegularSeasonEvents,
} from "./nflEventSync.ts";

test("parses scheduled regular-season games and preserves TBD kickoff metadata", () => {
  const parsed = parseEspnRegularSeasonEvents({
    events: [{
      id: "401872954",
      date: "2026-09-27T17:00Z",
      season: { year: 2026, type: 2 },
      week: { number: 3 },
      competitions: [{
        date: "2026-09-27T17:00Z",
        timeValid: true,
        venue: { fullName: "Ford Field" },
        broadcasts: [{ names: ["FOX"] }],
        competitors: [
          { homeAway: "home", score: "0", team: { abbreviation: "DET" } },
          { homeAway: "away", score: "0", team: { abbreviation: "NYJ" } },
        ],
        status: { type: { state: "pre", completed: false, name: "STATUS_SCHEDULED" } },
      }],
    }, {
      id: "tbd",
      date: "2026-12-20T18:00Z",
      season: { year: 2026, type: 2 },
      week: { number: 16 },
      competitions: [{
        date: "2026-12-20T18:00Z",
        timeValid: false,
        competitors: [
          { homeAway: "home", team: { abbreviation: "BUF" } },
          { homeAway: "away", team: { abbreviation: "MIA" } },
        ],
      }],
    }],
  }, 2026);
  assert.equal(parsed.length, 2);
  assert.deepEqual({
    away: parsed[0].awayAbbreviation,
    home: parsed[0].homeAbbreviation,
    week: parsed[0].week,
    kickoff: parsed[0].kickoffAt?.toISOString(),
    status: parsed[0].status,
    network: parsed[0].network,
  }, {
    away: "NYJ",
    home: "DET",
    week: 3,
    kickoff: "2026-09-27T17:00:00.000Z",
    status: "scheduled",
    network: "FOX",
  });
  assert.equal(parsed[1].kickoffAt, null);
});

test("carries the exact scoreboard request provenance into every parsed game", () => {
  const sourceUrl = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260801-20270228&limit=1000";
  const fetchedAt = "2026-09-20T14:04:12.345Z";
  const [parsed] = parseEspnRegularSeasonEvents({
    provenance: { sourceUrl, fetchedAt },
    events: [{
      id: "401872954",
      date: "2026-09-27T17:00Z",
      season: { year: 2026, type: 2 },
      week: { number: 3 },
      competitions: [{
        competitors: [
          { homeAway: "home", score: "24", team: { abbreviation: "DET" } },
          { homeAway: "away", score: "17", team: { abbreviation: "NYJ" } },
        ],
        status: { type: { state: "post", completed: true } },
      }],
    }],
  }, 2026);
  assert.equal(parsed.sourceUrl, sourceUrl);
  assert.equal(parsed.sourceFetchedAt?.toISOString(), fetchedAt);
});

test("ignores preseason and postseason events", () => {
  const event = {
    id: "x", date: "2026-08-01T00:00Z", season: { year: 2026, type: 1 },
    week: { number: 1 }, competitions: [],
  };
  assert.deepEqual(parseEspnRegularSeasonEvents({ events: [event] }, 2026), []);
});

test("rejects incomplete and duplicate schedule payloads before database writes", () => {
  const game = {
    id: "duplicate",
    date: "2026-09-27T17:00Z",
    season: { year: 2026, type: 2 },
    week: { number: 3 },
    competitions: [{
      competitors: [
        { homeAway: "home", team: { abbreviation: "DET" } },
        { homeAway: "away", team: { abbreviation: "NYJ" } },
      ],
    }],
  };
  assert.throws(
    () => validateEspnRegularSeasonEvents({ events: [game, game] }, 2026),
    /Expected 272/,
  );
});