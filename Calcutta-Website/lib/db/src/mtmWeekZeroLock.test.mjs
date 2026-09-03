import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const { Pool } = pg;
const MTM_SEASON_LOCK_NAMESPACE = 7_140;
const databaseUrl = process.env.DATABASE_URL;

test(
  "season lock serializes competing first Week 0 date claims",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const first = await pool.connect();
    const second = await pool.connect();

    try {
      await first.query("begin");
      await second.query("begin");
      await first.query(
        "select pg_advisory_xact_lock($1, $2)",
        [MTM_SEASON_LOCK_NAMESPACE, 2],
      );

      let secondClaimed = false;
      const secondClaim = second
        .query("select pg_advisory_xact_lock($1, $2)", [
          MTM_SEASON_LOCK_NAMESPACE,
          2,
        ])
        .then(() => {
          secondClaimed = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(secondClaimed, false);

      await first.query("commit");
      await secondClaim;
      assert.equal(secondClaimed, true);
      await second.query("commit");
    } finally {
      try {
        await first.query("rollback");
      } catch {
        // The transaction may already have committed.
      }
      try {
        await second.query("rollback");
      } catch {
        // The transaction may already have committed.
      }
      first.release();
      second.release();
      await pool.end();
    }
  },
);