import assert from "node:assert/strict";
import test from "node:test";
import { isJobRunnerRequest } from "./jobs.ts";

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
  } finally {
    if (savedSecret === undefined) delete process.env.JOB_RUNNER_SECRET;
    else process.env.JOB_RUNNER_SECRET = savedSecret;
  }
});