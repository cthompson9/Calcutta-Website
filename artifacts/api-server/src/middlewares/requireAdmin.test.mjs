import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";
import { requireAdmin } from "./requireAdmin.ts";

function serve(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test("shared admin middleware accepts only a Bearer token", async () => {
  const prior = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "middleware-test-key";
  const app = express();
  app.post("/write", requireAdmin, (_req, res) => res.sendStatus(204));
  const { server, url } = await serve(app);
  try {
    for (const authorization of [undefined, "middleware-test-key", "Bearer wrong-key"]) {
      const response = await fetch(`${url}/write`, {
        method: "POST",
        headers: authorization ? { Authorization: authorization } : undefined,
      });
      assert.equal(response.status, 401);
    }
    const response = await fetch(`${url}/write`, {
      method: "POST",
      headers: { Authorization: "Bearer middleware-test-key" },
    });
    assert.equal(response.status, 204);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (prior === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prior;
  }
});