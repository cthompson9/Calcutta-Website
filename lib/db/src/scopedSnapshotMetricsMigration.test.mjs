import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { scopedSnapshotMetricsMigration } from "./migrations/0019ScopedSnapshotMetrics.ts";

const databaseUrl = process.env.DATABASE_URL;
const { Pool } = pg;

async function withPre0019Schema(run) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `snapshot_metrics_0019_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}, public`);
    await client.query(`
      create table calcuttas (id integer primary key);
      create table calcutta_entries (id integer primary key, calcutta_id integer not null);
      create table calcutta_rules (id integer primary key);
      create table snapshot_metrics (
        id serial primary key,
        entry_id integer not null,
        period_id integer not null,
        basis text not null,
        metric text not null
      );
      create unique index snapshot_metrics_entry_period_basis_metric_idx
        on snapshot_metrics(entry_id, period_id, basis, metric);
    `);
    await run(client);
  } finally {
    await client.query("reset search_path").catch(() => {});
    await client.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    client.release();
    await pool.end();
  }
}

test("0019 executes against a pre-migration PostgreSQL shape without losing rows", { skip: !databaseUrl }, async () => {
  await withPre0019Schema(async (client) => {
    await client.query(`
      insert into calcuttas values (1);
      insert into calcutta_entries values (10, 1);
      insert into snapshot_metrics (entry_id, period_id, basis, metric) values (10, 7, 'mtm', 'win');
    `);
    await client.query("begin");
    try {
      await client.query(scopedSnapshotMetricsMigration.sql);
      const backfilled = await client.query(
        "select calcutta_id, entry_id from snapshot_metrics order by id",
      );
      assert.deepEqual(backfilled.rows, [{ calcutta_id: 1, entry_id: 10 }]);
      assert.equal((await client.query("select count(*)::int as count from snapshot_metrics")).rows[0].count, 1);

      await client.query(
        "insert into snapshot_metrics (calcutta_id, entry_id, period_id, basis, metric) values (1, null, 7, 'mtm', 'pool_win')",
      );
      await assert.rejects(
        client.query(
          "insert into snapshot_metrics (calcutta_id, entry_id, period_id, basis, metric) values (1, 10, 7, 'mtm', 'win')",
        ),
      );
      await assert.rejects(
        client.query(
          "insert into snapshot_metrics (calcutta_id, entry_id, period_id, basis, metric) values (1, null, 7, 'mtm', 'pool_win')",
        ),
      );
    } finally {
      await client.query("rollback");
    }
  });
});

test("0019 rejects inconsistent orphan entry data and rolls its DDL back", { skip: !databaseUrl }, async () => {
  await withPre0019Schema(async (client) => {
    await client.query(
      "insert into snapshot_metrics (entry_id, period_id, basis, metric) values (999, 7, 'mtm', 'win')",
    );
    await client.query("begin");
    try {
      await assert.rejects(
        client.query(scopedSnapshotMetricsMigration.sql),
        /backfill left null rows|orphaned entry rows/i,
      );
    } finally {
      await client.query("rollback");
    }
    const column = await client.query(`
      select 1 from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'snapshot_metrics'
        and column_name = 'calcutta_id'
    `);
    assert.equal(column.rowCount, 0);
    assert.equal((await client.query("select count(*)::int as count from snapshot_metrics")).rows[0].count, 1);
  });
});