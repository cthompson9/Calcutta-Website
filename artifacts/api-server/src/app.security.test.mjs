import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import test from "node:test";
import app, { apiErrorHandler } from "./app.ts";

function serve(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test("error handler returns a request id without implementation details", async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.id = "request_test_123";
    next();
  });
  app.get("/boom", () => { throw new Error("SQL /private/path leaked"); });
  app.use(apiErrorHandler);
  const { server, url } = await serve(app);
  try {
    const response = await fetch(`${url}/boom`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: "Internal error", requestId: "request_test_123" });
    assert.doesNotMatch(JSON.stringify(body), /SQL|private/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("API applies CORS, security headers, strict limits, and commissioner write authentication", async () => {
  const { server, url } = await serve(app);
  try {
    const health = await fetch(`${url}/api/healthz`, {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(health.headers.get("access-control-allow-credentials"), "true");
    assert.equal(health.headers.get("x-powered-by"), null);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");

    const blockedOrigin = await fetch(`${url}/api/healthz`, {
      headers: { Origin: "https://not-allowed.example" },
    });
    assert.equal(blockedOrigin.status, 500);
    assert.equal((await blockedOrigin.json()).error, "Internal error");

    const oauthForm = await fetch(`${url}/api/mcp/oauth/authorize`, {
      method: "POST",
      headers: {
        Origin: "https://not-allowed.example",
        "X-Forwarded-For": "198.51.100.30",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "decision=approve",
    });
    assert.equal(oauthForm.status, 400);
    assert.notEqual((await oauthForm.json()).error, "Internal error");

    for (const path of ["/api/bidders", "/api/seasons", "/api/trades/1"]) {
      const response = await fetch(`${url}${path}`, {
        method: path === "/api/trades/1" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 401, `${path} must reject unauthenticated writes`);
    }

    const tradeProposal = await fetch(`${url}/api/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(tradeProposal.status, 400, "trade proposals are public but still validate their body");

    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(`${url}/api/admin/validate`, {
        headers: { Authorization: "Bearer deliberately-invalid" },
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(statuses[5], 429);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});