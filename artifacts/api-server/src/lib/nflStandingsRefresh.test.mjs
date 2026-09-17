import assert from "node:assert/strict";
import test from "node:test";
import { resolveNflEventPayload } from "./nflStandingsRefresh.ts";

test("scheduled refresh reuses the already-fetched ESPN event payload", async () => {
  const payload = { events: [{ id: "already-fetched" }] };
  assert.strictEqual(await resolveNflEventPayload(2026, payload), payload);
});