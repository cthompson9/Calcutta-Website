import assert from "node:assert/strict";
import test from "node:test";
import {
  hasLiveOrRecentlyFinalNflGame,
  shouldRefreshNflScheduleCache,
  shouldRunStandingsRefresh,
} from "./nflSchedule.ts";

const NOW = Date.parse("2026-09-13T20:00:00.000Z");

test("standings refresh runs while an NFL game is live", () => {
  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: [{ state: "in", completed: false, statusUpdatedAt: null }],
      lastSuccessfulRunAt: new Date(NOW),
      nowMs: NOW,
    }),
    true,
  );
});

test("standings refresh runs for a recently final NFL game", () => {
  assert.equal(
    hasLiveOrRecentlyFinalNflGame(
      [{ state: "post", completed: true, statusUpdatedAt: "2026-09-13T19:50:00.000Z" }],
      NOW,
    ),
    true,
  );
});

test("standings refresh fast-exits when games are inactive and data is fresh", () => {
  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: [{ state: "pre", completed: false, statusUpdatedAt: null }],
      lastSuccessfulRunAt: new Date(NOW - 60_000),
      nowMs: NOW,
    }),
    false,
  );
});

test("force and stale schedules bypass the inactive-game fast exit", () => {
  const inactiveGames = [{ state: "pre", completed: false, statusUpdatedAt: null }];
  assert.equal(
    shouldRunStandingsRefresh({
      force: true,
      games: inactiveGames,
      lastSuccessfulRunAt: new Date(NOW),
      nowMs: NOW,
    }),
    true,
  );
  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: inactiveGames,
      lastSuccessfulRunAt: new Date(NOW - 25 * 60 * 60 * 1000),
      nowMs: NOW,
    }),
    true,
  );
  assert.equal(
    shouldRefreshNflScheduleCache(
      { seasonYear: 2026, fetchedAtMs: NOW - 25 * 60 * 60 * 1000, games: inactiveGames },
      2026,
      NOW,
    ),
    true,
  );
});