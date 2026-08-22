import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const { Pool } = pg;

test(
  "the 2025 legacy half-win records are backfilled as explicit records",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const { rows } = await pool.query(
        `
          SELECT t.name, r.wins, r.losses, r.ties
          FROM team_results r
          JOIN teams t ON t.id = r.team_id
          JOIN seasons s ON s.id = r.season_id
          WHERE s.year = $1
            AND t.name = ANY($2::text[])
          ORDER BY t.name
        `,
        [2025, ["Dallas Cowboys", "Green Bay Packers"]],
      );

      assert.deepEqual(rows, [
        { name: "Dallas Cowboys", wins: "7.0", losses: 9, ties: 1 },
        { name: "Green Bay Packers", wins: "9.0", losses: 7, ties: 1 },
      ]);
    } finally {
      await pool.end();
    }
  },
);
