import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import app from "../app.ts";

async function listen() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

test("Calcutta creation requires admin credentials and rejects invalid rubrics before persistence", async () => {
  const savedAdminKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "calcutta-create-test";
  const { server, baseUrl } = await listen();
  try {
    const body = {
      sport: "MLB",
      type: "postseason",
      year: 2198,
      lots: ["Yankees", "Dodgers"],
      scoringFormat: "percentage",
      rubric: [{ event: "Champion", value: 60 }, { event: "Runner-up", value: 39 }],
    };
    const unauthorized = await fetch(`${baseUrl}/api/calcuttas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(unauthorized.status, 401);

    const invalidRubric = await fetch(`${baseUrl}/api/calcuttas`, {
      method: "POST",
      headers: {
        Authorization: "Bearer calcutta-create-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(invalidRubric.status, 400);
    assert.match((await invalidRubric.json()).error, /total exactly 100/i);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    if (savedAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = savedAdminKey;
  }
});