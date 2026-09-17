import assert from "node:assert/strict";
import test from "node:test";
import { createNflRefreshPoller, NFL_REFRESH_POLL_INTERVAL_MS } from "./nflRefreshPoller.ts";

test("poller prevents overlapping ticks and stops future ticks", async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const poller = createNflRefreshPoller(async () => {
    calls += 1;
    await blocked;
  }, 5);
  const first = poller.runNow();
  await poller.runNow();
  assert.equal(calls, 1);
  poller.stop();
  release();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
});

test("production poll cadence is no slower than five minutes", () => {
  assert.equal(NFL_REFRESH_POLL_INTERVAL_MS, 5 * 60 * 1000);
});