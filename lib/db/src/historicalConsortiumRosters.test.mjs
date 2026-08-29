import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  loadHistoricalConsortiumRosters,
  parseHistoricalConsortiumRosters,
} from "./historicalConsortiumRosters.ts";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(
  workspaceRoot,
  "decisions/historical-consortium-rosters.txt",
);

test("authoritative historical consortium roster parses without inferred assignments", async () => {
  const records = parseHistoricalConsortiumRosters(
    await readFile(sourcePath, "utf8"),
  );
  assert.equal(records.length, 88);
  assert.equal(records.filter((record) => record.consortium == null).length, 8);
  assert.deepEqual(
    records.find(
      (record) =>
        record.edition === 10 &&
        record.sourceOwnerLabel === "Samuel Rosen",
    ),
    {
      edition: 10,
      sourceOwnerLabel: "Samuel Rosen",
      normalizedOwnerLabel: "Samuel Rosen",
      consortium: "Sam R.",
    },
  );
  assert.deepEqual(
    records.find(
      (record) =>
        record.edition === 10 &&
        record.sourceOwnerLabel === "Kevin/Daniel?",
    ),
    {
      edition: 10,
      sourceOwnerLabel: "Kevin/Daniel?",
      normalizedOwnerLabel: "KD",
      consortium: "Kurt D. / Joey A.",
    },
  );
  assert.equal(
    records.find(
      (record) =>
        record.edition === 11 &&
        record.sourceOwnerLabel === "Ezra Pemstein",
    )?.consortium,
    null,
  );
});

test(
  "historical consortium roster migration and loaded mapping are complete",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const firstLoad = await loadHistoricalConsortiumRosters(sourcePath);
      const timestampsBefore = await pool.query(`
        select id, recorded_at
        from historical_calcutta_rosters
        order by id
      `);
      const secondLoad = await loadHistoricalConsortiumRosters(sourcePath);
      const timestampsAfter = await pool.query(`
        select id, recorded_at
        from historical_calcutta_rosters
        order by id
      `);
      assert.deepEqual(secondLoad, firstLoad);
      assert.deepEqual(timestampsAfter.rows, timestampsBefore.rows);

      const [migration, summary, unresolved, calcuttaEight, links] =
        await Promise.all([
        pool.query(`
          select count(*)::int as count
          from app_schema_migrations
          where version in (
            '0021_historical_calcutta_rosters_v1',
            '0023_historical_calcutta_links_v1'
          )
        `),
        pool.query(`
          select
            count(*)::int as records,
            count(*) filter (where consortium_id is null)::int as unassigned,
            count(*) filter (where owner_id is null)::int as unresolved,
            count(*) filter (where bidder_id is not null)::int as bridged
          from historical_calcutta_rosters
        `),
        pool.query(`
          select c.edition_number, r.source_owner_label, con.name as consortium
          from historical_calcutta_rosters r
          join normalized_calcuttas c on c.id = r.calcutta_id
          left join consortia con on con.id = r.consortium_id
          where r.owner_id is null
        `),
        pool.query(`
          select r.source_owner_label, con.name as consortium, b.name as bidder
          from historical_calcutta_rosters r
          join normalized_calcuttas c on c.id = r.calcutta_id
          left join consortia con on con.id = r.consortium_id
          left join bidders b on b.id = r.bidder_id
          where c.edition_number = 8
          order by r.source_owner_label
        `),
        pool.query(`
          select
            count(*)::int as count,
            array_agg(n.edition_number order by n.edition_number) as editions,
            count(*) filter (where c.year = 2026 and c.sport = 'NFL')::int as live_nfl
          from historical_calcutta_links l
          join normalized_calcuttas n on n.id = l.normalized_calcutta_id
          join calcuttas c on c.id = l.legacy_calcutta_id
        `),
      ]);
      assert.equal(migration.rows[0].count, 2);
      assert.deepEqual(summary.rows[0], {
        records: 88,
        unassigned: 8,
        unresolved: 1,
        bridged: 58,
      });
      assert.deepEqual(unresolved.rows, [
        {
          edition_number: 5,
          source_owner_label: "Zack Miller",
          consortium: "Zack M. / Ezra P.",
        },
      ]);
      assert.equal(calcuttaEight.rows.length, 9);
      assert.deepEqual(links.rows[0], {
        count: 11,
        editions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        live_nfl: 0,
      });
      assert.deepEqual(
        calcuttaEight.rows.find(
          (row) => row.source_owner_label === "Zachary Long",
        ),
        {
          source_owner_label: "Zachary Long",
          consortium: "Zach L. / Greg K.",
          bidder: "Zachary Long",
        },
      );
    } finally {
      await pool.end();
    }
  },
);