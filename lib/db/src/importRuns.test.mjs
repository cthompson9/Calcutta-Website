/**
 * Import runs make completed source imports idempotent per season and source.
 * Requires DATABASE_URL; skipped outside a database test environment.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const canRun = Boolean(databaseUrl);

let pool;
let seasonId;

if (canRun) {
  const { Pool } = pg;
  pool = new Pool({ connectionString: databaseUrl });
}

describe("import run idempotency", { skip: !canRun }, () => {
  before(async () => {
    const { rows } = await pool.query(
      `INSERT INTO seasons (year, is_active, is_complete, label)
       VALUES ($1, false, false, $2)
       RETURNING id`,
      [
        1_400_000_000 + Math.floor(Math.random() * 100_000_000),
        "Import-run test fixture — safe to delete",
      ],
    );
    seasonId = rows[0].id;
  });

  after(async () => {
    if (seasonId) {
      await pool.query("DELETE FROM import_runs WHERE season_id = $1", [seasonId]);
      await pool.query("DELETE FROM seasons WHERE id = $1", [seasonId]);
    }
    await pool.end();
  });

  test("allows one provenance record per season, source, and source hash", async () => {
    const values = [
      seasonId,
      "auctionpro_json",
      "test-source-hash",
      32,
      32,
      "admin_api",
      "import-runs-test",
    ];
    const insert = () =>
      pool.query(
        `INSERT INTO import_runs
          (season_id, source, source_hash, imported_teams, imported_owners, requested_by, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        values,
      );
    await insert();

    await assert.rejects(
      insert(),
      /duplicate key|unique/i,
      "the database prevents duplicate records for the identical source",
    );
  });
});