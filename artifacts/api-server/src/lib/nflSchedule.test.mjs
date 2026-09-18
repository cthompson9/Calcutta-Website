import assert from "node:assert/strict";
import test from "node:test";
import {
  hasNewlyCompletedNflGame,
  hasLiveOrRecentlyFinalNflGame,
  isNflGameInPostKickoffPollingWindow,
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
      games: [{ sourceEventId: "live", kickoffAt: null, state: "in", completed: false, statusUpdatedAt: null }],
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
      [{ sourceEventId: "final", kickoffAt: null, state: "post", completed: true, statusUpdatedAt: "2026-09-13T19:50:00.000Z" }],
      NOW,
    ),
    true,
  );
});

test("standings refresh fast-exits when games are inactive and data is fresh", () => {
  assert.equal(
    shouldRunStandingsRefresh({
      force: false,
      games: [{ sourceEventId: "pregame", kickoffAt: null, state: "pre", completed: false, statusUpdatedAt: null }],
      lastSuccessfulRunAt: new Date(NOW - 60_000),
      lastGameStatusSignature: null,
      nowMs: NOW,
    }),
    false,
  );
});

test("force and stale schedules bypass the inactive-game fast exit", () => {
  const inactiveGames = [{ sourceEventId: "inactive", kickoffAt: null, state: "pre", completed: false, statusUpdatedAt: null }];
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

test("a cached schedule prompts status lookup starting two hours after kickoff", () => {
  const game = {
    sourceEventId: "delayed",
    kickoffAt: "2026-09-13T19:00:00.000Z",
    state: "pre",
    completed: false,
    statusUpdatedAt: null,
  };
  assert.equal(needsFreshNflGameStatus([game], Date.parse("2026-09-13T20:59:59.000Z")), false);
  assert.equal(needsFreshNflGameStatus([game], Date.parse("2026-09-13T21:00:00.000Z")), true);
  assert.equal(needsFreshNflGameStatus([game], Date.parse("2026-09-14T03:00:00.000Z")), false);
});

test("an ESPN final with only a kickoff date runs once when its status changes", () => {
  const liveGame = {
    sourceEventId: null,
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

test("post-kickoff polling ends six hours after kickoff", () => {
  const game = {
    sourceEventId: "window",
    kickoffAt: "2026-09-13T19:00:00.000Z",
    state: "pre",
    completed: false,
    statusUpdatedAt: null,
  };
  assert.equal(
    isNflGameInPostKickoffPollingWindow(game, Date.parse("2026-09-14T01:00:00.000Z")),
    true,
  );
  assert.equal(
    isNflGameInPostKickoffPollingWindow(game, Date.parse("2026-09-14T01:00:00.001Z")),
    false,
  );
});

test("only a new provider final triggers actuals processing", () => {
  const scheduled = {
    sourceEventId: "transition",
    kickoffAt: "2026-09-13T19:00:00.000Z",
    state: "pre",
    completed: false,
    statusUpdatedAt: null,
  };
  const final = { ...scheduled, state: "post", completed: true };
  assert.equal(hasNewlyCompletedNflGame([scheduled], [final]), true);
  assert.equal(hasNewlyCompletedNflGame([final], [final]), false);
});