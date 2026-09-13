import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";

const canRun = Boolean(process.env.DATABASE_URL);

let closeDatabasePool;
let db;
let runDatabaseMigrations;
let withMtmLock;
let target;
const cleanupRunIds = new Set();

if (canRun) {
  ({ closeDatabasePool, db, runDatabaseMigrations } = await import("@workspace/db"));
  ({ withMtmLock } = await import("./mtmPipeline.ts"));
}

before(async () => {
  if (!canRun) return;
  await runDatabaseMigrations();
  const result = await db.execute(sql`
    select seasons.year, calcuttas.id
    from calcuttas
    inner join seasons on seasons.id = calcuttas.season_id
    where calcuttas.sport = 'NFL'
    order by calcuttas.is_canonical desc, seasons.year desc, calcuttas.id desc
    limit 1
  `);
  const row = result.rows[0];
  if (row) target = { seasonYear: Number(row.year), calcuttaId: Number(row.id) };
});

after(async () => {
  if (!canRun) return;
  for (const runId of cleanupRunIds) {
    await db.execute(sql`delete from mtm_job_runs where run_id = ${runId}`);
  }
  if (target) {
    await db.execute(sql`
      delete from mtm_job_leases
      where pool_id = ${target.calcuttaId}
        and run_id in (${sql.join([...cleanupRunIds].map((id) => sql`${id}`), sql`, `)})
    `);
  }
  await closeDatabasePool();
});

test("an active MTM lease rejects a competing worker", { skip: !canRun }, async (t) => {
  if (!target) return t.skip("No NFL Calcutta is available for the lease test.");
  let releaseFirst;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const firstPromise = withMtmLock(target, async (lease) => {
    cleanupRunIds.add(lease.runId);
    signalStarted();
    await release;
    return { runId: lease.runId };
  });
  await started;
  const second = await withMtmLock(target, async () => {
    throw new Error("A competing worker must not acquire an active lease.");
  });
  assert.equal(second.acquired, false);
  releaseFirst();
  const first = await firstPromise;
  assert.equal(first.acquired, true);

  const run = await db.execute(sql`
    select status from mtm_job_runs where run_id = ${first.value.runId}
  `);
  assert.equal(run.rows[0]?.status, "completed");
});

test("an expired lease is taken over and its run is marked abandoned", { skip: !canRun }, async (t) => {
  if (!target) return t.skip("No NFL Calcutta is available for the lease test.");
  const staleRunId = `lease-test-stale-${Date.now()}`;
  const staleOwner = `lease-test-owner-${Date.now()}`;
  cleanupRunIds.add(staleRunId);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into mtm_job_runs (
        run_id, pool_id, owner_token, status, started_at, heartbeat_at, lease_until
      ) values (
        ${staleRunId}, ${target.calcuttaId}, ${staleOwner}, 'running',
        now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '5 minutes'
      )
    `);
    await tx.execute(sql`
      insert into mtm_job_leases (
        pool_id, owner_token, run_id, lease_until, heartbeat_at, started_at, updated_at
      ) values (
        ${target.calcuttaId}, ${staleOwner}, ${staleRunId},
        now() - interval '5 minutes', now() - interval '10 minutes',
        now() - interval '10 minutes', now()
      )
    `);
  });

  const takeover = await withMtmLock(target, async (lease) => {
    cleanupRunIds.add(lease.runId);
    return { runId: lease.runId };
  });
  assert.equal(takeover.acquired, true);

  const stale = await db.execute(sql`
    select status, failure_kind from mtm_job_runs where run_id = ${staleRunId}
  `);
  assert.equal(stale.rows[0]?.status, "abandoned");
  assert.equal(stale.rows[0]?.failure_kind, "lease_expired");
});