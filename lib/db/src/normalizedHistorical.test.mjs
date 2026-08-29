import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      record.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const [headers, ...rows] = records;
  return rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])),
  );
}

function canonicalOwnership(value) {
  return value.split(", ").sort().join(", ");
}

test(
  "Stage-1 normalized history migration is additive and fully registered",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const [migration, relations, views, trigger] = await Promise.all([
        pool.query(`
          select count(*)::int as count
          from app_schema_migrations
          where version = '0020_normalized_historical_v6'
        `),
        pool.query(`
          select count(*)::int as count
          from information_schema.tables
          where table_schema = 'public'
            and table_name in (
              'competition_formats',
              'format_periods',
              'normalized_calcuttas',
              'normalized_owners',
              'normalized_calcutta_owners',
              'normalized_teams',
              'normalized_entries',
              'normalized_entry_teams',
              'normalized_positions',
              'normalized_trades',
              'normalized_scoring_rules',
              'normalized_scoring_events',
              'normalized_expected_entry_results',
              'normalized_expected_owner_results',
              'normalized_import_runs'
            )
        `),
        pool.query(`
          select count(*)::int as count
          from information_schema.views
          where table_schema = 'public'
            and table_name in ('v_tracking', 'v_entry_results', 'v_owner_results')
        `),
        pool.query(`
          select count(*)::int as count
          from pg_trigger
          where tgname = 'normalized_positions_net_one'
            and tgconstraint <> 0
        `),
      ]);
      assert.equal(migration.rows[0].count, 1);
      assert.equal(relations.rows[0].count, 15);
      assert.equal(views.rows[0].count, 3);
      assert.equal(trigger.rows[0].count, 1);
    } finally {
      await pool.end();
    }
  },
);

test(
  "loaded history is complete and every primary ownership split nets to one",
  { skip: !databaseUrl },
  async (context) => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const counts = await pool.query(`
        select
          (select count(*)::int from normalized_import_runs) as imports,
          (select count(*)::int from normalized_calcuttas) as pools,
          (select count(*)::int from normalized_entries) as entries,
          (select count(*)::int from normalized_expected_entry_results
            where realized_return is not null) as expected_returns,
          (select count(*)::int from normalized_expected_entry_results
            where points is not null) as expected_points,
          (select count(*)::int from normalized_expected_owner_results
            where realized is not null) as expected_owners,
          (select count(*)::int from normalized_owners) as owners,
          (select count(*)::int from normalized_trades) as trades
      `);
      if (counts.rows[0].imports === 0) {
        context.skip("historical source files have not been loaded in this database");
        return;
      }
      assert.deepEqual(counts.rows[0], {
        imports: 11,
        pools: 11,
        entries: 456,
        expected_returns: 456,
        expected_points: 112,
        expected_owners: 82,
        owners: 73,
        trades: 118,
      });
      const invalidSplits = await pool.query(`
        select count(*)::int as count
        from (
          select entry_id
          from normalized_positions
          where source = 'primary'
          group by entry_id
          having sum(share) <> 1.000000
        ) invalid
      `);
      assert.equal(invalidSplits.rows[0].count, 0);
    } finally {
      await pool.end();
    }
  },
);

test(
  "normalized SQL views reproduce every supplied reconciliation field",
  { skip: !databaseUrl },
  async (context) => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const loaded = await pool.query(
        "select count(*)::int as count from normalized_import_runs",
      );
      if (loaded.rows[0].count === 0) {
        context.skip("historical source files have not been loaded in this database");
        return;
      }
      const [expectedEntries, expectedOwners, entries, owners] =
        await Promise.all([
          readFile(resolve(workspaceRoot, "data/team-by-team.csv"), "utf8").then(
            parseCsv,
          ),
          readFile(resolve(workspaceRoot, "data/owner-by-owner.csv"), "utf8").then(
            parseCsv,
          ),
          pool.query(`
            select ed::text,calcutta,sport,lot,kind,seed,grouping,price::text,
              ownership,tracking,points::text,payout::text
            from v_entry_results
          `),
          pool.query(`
            select ed::text,calcutta,sport,owner,lots::text,cost::text,
              payout::text,(payout-cost)::text as net
            from v_owner_results
          `),
        ]);
      const entryKey = (row) => `${row.ed}\u0000${row.lot}`;
      const ownerKey = (row) => `${row.ed}\u0000${row.owner}`;
      const normalizeEntry = (row) => ({
        ...row,
        seed: row.seed ?? "",
        grouping: row.grouping ?? "",
        points: row.points ?? "",
        tracking: row.tracking ?? "",
        ownership: canonicalOwnership(row.ownership),
      });
      assert.deepEqual(
        entries.rows.map(normalizeEntry).sort((a, b) =>
          entryKey(a).localeCompare(entryKey(b)),
        ),
        expectedEntries.map(normalizeEntry).sort((a, b) =>
          entryKey(a).localeCompare(entryKey(b)),
        ),
      );
      assert.deepEqual(
        owners.rows.sort((a, b) => ownerKey(a).localeCompare(ownerKey(b))),
        expectedOwners.sort((a, b) => ownerKey(a).localeCompare(ownerKey(b))),
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "each historical pool persists its exact period ladder",
  { skip: !databaseUrl },
  async (context) => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const loaded = await pool.query(
        "select count(*)::int as count from normalized_import_runs",
      );
      if (loaded.rows[0].count === 0) {
        context.skip("historical source files have not been loaded in this database");
        return;
      }
      const documents = await Promise.all(
        Array.from({ length: 11 }, (_, index) =>
          readFile(
            resolve(
              workspaceRoot,
              `data/calcutta-${String(index + 1).padStart(2, "0")}.json`,
            ),
            "utf8",
          ).then(JSON.parse),
        ),
      );
      const persisted = await pool.query(`
        select c.edition_number as edition,p.key,p.seq,p.label,p.kind,
          p.weight::text,p.is_scored,c.format_key
        from normalized_calcuttas c
        join format_periods p on p.format_key=c.format_key
        order by c.edition_number,p.seq
      `);
      const expected = documents.flatMap((document) =>
        (document.periods ?? []).map((period) => ({
          edition: document.edition,
          key: period.key,
          seq: period.seq,
          label: period.label ?? period.key,
          kind: period.kind ?? "regular",
          weight: period.weight ?? 1,
          isScored: period.is_scored ?? true,
        })),
      );
      assert.deepEqual(
        persisted.rows.map((period) => ({
          edition: period.edition,
          key: period.key,
          seq: period.seq,
          label: period.label,
          kind: period.kind,
          weight: Number(period.weight),
          isScored: period.is_scored,
        })),
        expected,
      );
      const nflFormats = await pool.query(`
        select edition_number,format_key
        from normalized_calcuttas
        where edition_number in (3,8)
        order by edition_number
      `);
      assert.notEqual(
        nflFormats.rows[0].format_key,
        nflFormats.rows[1].format_key,
        "incompatible historical NFL period ladders need versioned formats",
      );
      assert.ok(
        persisted.rows.some(
          (period) =>
            period.edition === 8 &&
            period.key === "WK0" &&
            period.seq === 1 &&
            period.kind === "baseline",
        ),
      );
    } finally {
      await pool.end();
    }
  },
);