import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./routes/listener.ts", import.meta.url), "utf8");

test("listener event route binds website session to authenticated session and bounds input", () => {
  assert.match(source, /e\.websiteSessionId !== s\.id/);
  assert.match(source, /z\.array\(recallEvent\)\.min\(1\)\.max\(100\)/);
  assert.match(source, /bytes > 256 \* 1024/);
  assert.match(source, /onConflictDoNothing/);
  assert.match(source, /locked\.revokedAt \|\| locked\.expiresAt <= new Date\(\)/);
});

test("listener ticket and status routes enforce origin, admin middleware, and no-store", () => {
  assert.match(source, /router\.post\("\/listener\/tickets", requireAdmin/);
  assert.match(source, /router\.get\("\/listener\/status", requireAdmin/);
  assert.match(source, /body\.data\.origin !== publicOrigin\(\)/);
  assert.match(source, /Cache-Control", "no-store"/);
  assert.match(source, /router\.post\("\/listener\/revoke", requireAdmin/);
});

test("completed auctions are rejected by ticket/open-auction and public projection paths", () => {
  assert.match(source, /status\} <> 'complete'/);
  assert.match(source, /auction\.status === "complete"/);
  assert.match(source, /if \(!auction \|\| auction\.status === "complete"\)/);
});