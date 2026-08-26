import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import app from "../app.ts";
import {
  isJobRunnerRequest,
  withRefreshJobLock,
} from "./jobs.ts";
import {
  canonicalMtmSnapshotKey,
  latestFullyCoveredNflPeriod,
} from "../lib/jobMtmRefresh.ts";

test("job runner authentication rejects missing and invalid bearer tokens", () => {
  const savedSecret = process.env.JOB_RUNNER_SECRET;
  process.env.JOB_RUNNER_SECRET = "job-test-secret";
  try {
    assert.equal(isJobRunnerRequest({ headers: {} }), false);
    assert.equal(
      isJobRunnerRequest({ headers: { authorization: "Bearer incorrect-secret" } }),
      false,
    );
    assert.equal(
      isJobRunnerRequest({ headers: { authorization: "Basic job-test-secret" } }),
      false,
    );
    assert.equal(
      isJobRunnerRequest({ headers: { authorization: "Bearer job-test-secret" } }),
      true,
    );
    delete process.env.JOB_RUNNER_SECRET;
    assert.equal(
      isJobRunnerRequest({
        headers: { authorization: "Bearer job-test-secret" },
      }),
      false,
    );
  } finally {
    if (savedSecret === undefined) delete process.env.JOB_RUNNER_SECRET;
    else process.env.JOB_RUNNER_SECRET = savedSecret;
  }
});

test("job endpoint rejects unknown work before touching refresh state", async () => {
  const savedSecret = process.env.JOB_RUNNER_SECRET;
  process.env.JOB_RUNNER_SECRET = "job-test-secret";
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/jobs/refresh`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer job-test-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ job: "unknown" }),
      },
    );
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (savedSecret === undefined) delete process.env.JOB_RUNNER_SECRET;
    else process.env.JOB_RUNNER_SECRET = savedSecret;
  }
});

test("canonical marks use the latest fully covered realized NFL period", () => {
  const rows = Array.from({ length: 32 }, (_, entryId) => ({
    entryId,
    sequence: 0,
  }));
  assert.equal(
    latestFullyCoveredNflPeriod(rows, 32),
    0,
  );
  rows.push(
    ...Array.from({ length: 31 }, (_, entryId) => ({
      entryId,
      sequence: 1,
    })),
  );
  assert.equal(
    latestFullyCoveredNflPeriod(rows, 32),
    0,
  );
  rows.push({ entryId: 31, sequence: 1 });
  assert.equal(latestFullyCoveredNflPeriod(rows, 32), 1);
  assert.equal(canonicalMtmSnapshotKey(0), "week-0");
  assert.equal(canonicalMtmSnapshotKey(7), "canonical-mtm-period-7");
});

test(
  "refresh advisory lock rejects overlapping invocations without queueing",
  { skip: !process.env.DATABASE_URL },
  async () => {
    let releaseFirst;
    let signalEntered;
    const entered = new Promise((resolve) => {
      signalEntered = resolve;
    });
    const hold = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = withRefreshJobLock(async () => {
      signalEntered();
      await hold;
      return "first";
    });
    await entered;
    const second = await withRefreshJobLock(async () => "second");
    assert.deepEqual(second, { acquired: false });
    releaseFirst();
    assert.deepEqual(await first, { acquired: true, value: "first" });
  },
);