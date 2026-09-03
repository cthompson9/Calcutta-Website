import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  eventsTable,
  runDatabaseMigrations,
  seasonsTable,
  teamsTable,
} from "@workspace/db";
import app from "../app.ts";
import {
  isJobRunnerRequest,
  refreshJobLockKey,
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

test("refresh lock keys isolate NFL and CFB for the same season", () => {
  assert.notDeepEqual(
    refreshJobLockKey({
      seasonId: 7,
      sport: "NFL",
      competition: "NFL_REGULAR_SEASON",
    }),
    refreshJobLockKey({
      seasonId: 7,
      sport: "CFB",
      competition: "CFB_REGULAR_SEASON",
    }),
  );
});

test(
  "NFL and CFB refresh locks can be held concurrently",
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
      return "nfl";
    }, {
      seasonId: 7,
      sport: "NFL",
      competition: "NFL_REGULAR_SEASON",
    });
    await entered;
    const cfb = await withRefreshJobLock(async () => "cfb", {
      seasonId: 7,
      sport: "CFB",
      competition: "CFB_REGULAR_SEASON",
    });
    assert.deepEqual(cfb, { acquired: true, value: "cfb" });
    releaseFirst();
    assert.deepEqual(await first, { acquired: true, value: "nfl" });
  },
);

test(
  "concurrent NFL and CFB refresh writes keep overlapping provider IDs isolated",
  { skip: !process.env.DATABASE_URL },
  async () => {
    await runDatabaseMigrations();
    const [season] = await db.insert(seasonsTable).values({
      year: 2197,
      label: "2197 concurrent refresh test",
    }).returning({ id: seasonsTable.id });
    try {
      const teams = await db.select({ id: teamsTable.id }).from(teamsTable).limit(2);
      assert.equal(teams.length, 2);
      const write = (sport, competition) => withRefreshJobLock(
        () => db.transaction(async (tx) => {
          await tx.insert(eventsTable).values({
            seasonId: season.id,
            sport,
            competition,
            source: "espn",
            sourceEventId: "concurrent-shared-id",
            week: 1,
            eventDate: "2197-09-01",
            awayTeamId: teams[0].id,
            homeTeamId: teams[1].id,
          }).onConflictDoUpdate({
            target: [
              eventsTable.seasonId,
              eventsTable.sport,
              eventsTable.competition,
              eventsTable.source,
              eventsTable.sourceEventId,
            ],
            set: { status: "scheduled" },
          });
        }),
        { seasonId: season.id, sport, competition },
      );
      const [nfl, cfb] = await Promise.all([
        write("NFL", "NFL_REGULAR_SEASON"),
        write("CFB", "CFB_REGULAR_SEASON"),
      ]);
      assert.equal(nfl.acquired, true);
      assert.equal(cfb.acquired, true);
      const rows = await db.select().from(eventsTable).where(and(
        eq(eventsTable.seasonId, season.id),
        eq(eventsTable.sourceEventId, "concurrent-shared-id"),
      ));
      assert.deepEqual(new Set(rows.map((row) => row.sport)), new Set(["NFL", "CFB"]));
    } finally {
      await db.delete(seasonsTable).where(eq(seasonsTable.id, season.id));
    }
  },
);