import assert from "node:assert/strict";
import test from "node:test";
import {
  hasLiveOrRecentlyFinalNflGame,
  needsFreshNflGameStatus,
  nflGameStatusSignature,
  parseEspnNflSchedule,
  shouldRefreshNflScheduleCache,
  shouldRunStandingsRefresh,
} from "./nflSchedule.ts";

const NOW = Date.parse("2026-09-13T20:00:00.000Z");

test("standings refresh runs while an NFL game is live", () => {
  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: [{ kickoffAt: null, state: "in", completed: false, statusUpdatedAt: null }],
      lastSuccessfulRunAt: new Date(NOW),
      lastGameStatusSignature: null,
      nowMs: NOW,
    }),
    true,
  );
});

test("standings refresh runs for a recently final NFL game", () => {
  assert.equal(
    hasLiveOrRecentlyFinalNflGame(
      [{ kickoffAt: null, state: "post", completed: true, statusUpdatedAt: "2026-09-13T19:50:00.000Z" }],
      NOW,
    ),
    true,
  );
});

test("standings refresh fast-exits when games are inactive and data is fresh", () => {
  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: [{ kickoffAt: null, state: "pre", completed: false, statusUpdatedAt: null }],
      lastSuccessfulRunAt: new Date(NOW - 60_000),
      lastGameStatusSignature: null,
      nowMs: NOW,
    }),
    false,
  );
});

test("force and stale schedules bypass the inactive-game fast exit", () => {
  const inactiveGames = [{ kickoffAt: null, state: "pre", completed: false, statusUpdatedAt: null }];
  assert.equal(
    shouldRunStandingsRefresh({
      force: true,
      games: inactiveGames,
      lastSuccessfulRunAt: new Date(NOW),
      lastGameStatusSignature: null,
      nowMs: NOW,
    }),
    true,
  );
  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: inactiveGames,
      lastSuccessfulRunAt: new Date(NOW - 25 * 60 * 60 * 1000),
      lastGameStatusSignature: null,
      nowMs: NOW,
    }),
    true,
  );
  assert.equal(
    shouldRefreshNflScheduleCache(
      new Date(NOW - 25 * 60 * 60 * 1000),
      NOW,
    ),
    true,
  );
});

test("a cached pregame schedule prompts a fresh status lookup during the game window", () => {
  const game = {
    kickoffAt: "2026-09-13T19:00:00.000Z",
    state: "pre",
    completed: false,
    statusUpdatedAt: null,
  };
  assert.equal(needsFreshNflGameStatus([game], Date.parse("2026-09-13T19:30:00.000Z")), true);
  assert.equal(needsFreshNflGameStatus([game], Date.parse("2026-09-14T03:00:00.000Z")), false);
});

test("an ESPN final with only a kickoff date runs once when its status changes", () => {
  const liveGame = {
    kickoffAt: "2026-09-13T19:00:00.000Z",
    state: "in",
    completed: false,
    statusUpdatedAt: null,
  };
  const [finalGame] = parseEspnNflSchedule({
    events: [
      {
        date: liveGame.kickoffAt,
        status: { type: { state: "post", completed: true } },
      },
    ],
  });
  assert.deepEqual(finalGame, { ...liveGame, state: "post", completed: true });
  const finalSignature = nflGameStatusSignature([finalGame]);

  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: [finalGame],
      lastSuccessfulRunAt: new Date(NOW),
      lastGameStatusSignature: nflGameStatusSignature([liveGame]),
      nowMs: NOW,
    }),
    true,
  );
  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: [finalGame],
      lastSuccessfulRunAt: new Date(NOW),
      lastGameStatusSignature: finalSignature,
      nowMs: NOW,
    }),
    false,
  );
});