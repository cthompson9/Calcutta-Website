import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

test(
  "Phase 1 schema migration preserves live legacy data and seeds canonical NFL rules",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const [migration, tables, legacyRows, tradeMappings, rules] = await Promise.all([
        pool.query(
          "select count(*)::int as count from app_schema_migrations where version = '0012_platform_schema'",
        ),
        pool.query(`
          select count(*)::int as count
          from information_schema.tables
          where table_schema = 'public'
            and table_name in (
              'calcutta_rules',
              'events',
              'event_market_snapshots',
              'event_projections',
              'snapshot_metrics'
            )
        `),
        pool.query("select count(*)::int as count from team_period_snapshots"),
        pool.query(`
          select count(*)::int as count
          from trades t
          left join calcutta_entries ce on ce.id = t.entry_id
          left join calcuttas c on c.id = ce.calcutta_id
          where t.entry_id is null
             or ce.team_id is distinct from t.team_id
             or c.season_id is distinct from t.season_id
        `),
        pool.query(`
          select s.year as season_year, r.rule_name, r.rule_type, r.value::text as value
          from calcutta_rules r
          inner join calcuttas c on c.id = r.calcutta_id
          inner join seasons s on s.id = c.season_id
          where s.year in (2025, 2026)
            and c.sport = 'NFL'
            and c.is_canonical = true
          order by s.year, r.rule_name
        `),
      ]);

      assert.equal(migration.rows[0].count, 1);
      assert.equal(tables.rows[0].count, 5);
      // The migration's 128 historical rows must remain present. Later
      // realized-metric backfills legitimately append additional snapshots.
      assert.ok(legacyRows.rows[0].count >= 128);
      assert.equal(tradeMappings.rows[0].count, 0);
      assert.deepEqual(rules.rows, [
        { season_year: 2025, rule_name: "banked", rule_type: "points", value: "150.000000" },
        { season_year: 2025, rule_name: "win", rule_type: "points", value: "10.000000" },
        { season_year: 2026, rule_name: "banked", rule_type: "points", value: "150.000000" },
        { season_year: 2026, rule_name: "win", rule_type: "points", value: "10.000000" },
      ]);
    } finally {
      await pool.end();
    }
  },
);

test(
  "Phase 1 trade trigger derives entry_id for legacy season/team writes",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const source = await client.query(`
        select season_id, team_id, from_bidder_id, to_bidder_id
        from trades
        where from_bidder_id <> to_bidder_id
        order by id
        limit 1
      `);
      assert.ok(source.rows[0], "expected an existing trade fixture");

      const inserted = await client.query(
        `
          insert into trades (
            season_id, team_id, from_bidder_id, to_bidder_id, price, percentage, status, trade_date
          )
          values ($1, $2, $3, $4, 0, 1, 'pending', current_date)
          returning id, entry_id
        `,
        [
          source.rows[0].season_id,
          source.rows[0].team_id,
          source.rows[0].from_bidder_id,
          source.rows[0].to_bidder_id,
        ],
      );

      assert.ok(inserted.rows[0].entry_id);
      const mapping = await client.query(
        `
          select ce.team_id, c.season_id
          from calcutta_entries ce
          inner join calcuttas c on c.id = ce.calcutta_id
          where ce.id = $1
        `,
        [inserted.rows[0].entry_id],
      );
      assert.deepEqual(mapping.rows[0], {
        team_id: source.rows[0].team_id,
        season_id: source.rows[0].season_id,
      });

      const nonCanonical = await client.query(
        `
          insert into calcuttas (
            season_id, name, year, sport, competition_format, status, is_canonical
          )
          select
            s.id,
            'Phase 1 trigger isolation ' || txid_current()::text,
            s.year,
            'NFL',
            'NFL_REGULAR_SEASON',
            'active',
            false
          from seasons s
          where s.id = $1
          returning id
        `,
        [source.rows[0].season_id],
      );
      await client.query(
        "insert into calcutta_entries (calcutta_id, team_id) values ($1, $2)",
        [nonCanonical.rows[0].id, source.rows[0].team_id],
      );
      const existingTradeBackfillMapping = await client.query(
        `
          select min(ce.id) as entry_id, count(*)::int as entry_count
          from calcuttas c
          inner join calcutta_entries ce on ce.calcutta_id = c.id
          where c.season_id = $1
            and ce.team_id = $2
            and c.is_canonical = true
            and c.sport = 'NFL'
        `,
        [source.rows[0].season_id, source.rows[0].team_id],
      );
      assert.equal(existingTradeBackfillMapping.rows[0].entry_count, 1);
      assert.notEqual(existingTradeBackfillMapping.rows[0].entry_id, String(nonCanonical.rows[0].id));
      const canonicalInserted = await client.query(
        `
          insert into trades (
            season_id, team_id, from_bidder_id, to_bidder_id, price, percentage, status, trade_date
          )
          values ($1, $2, $3, $4, 0, 1, 'pending', current_date)
          returning entry_id
        `,
        [
          source.rows[0].season_id,
          source.rows[0].team_id,
          source.rows[0].from_bidder_id,
          source.rows[0].to_bidder_id,
        ],
      );
      const canonicalMapping = await client.query(
        `
          select c.is_canonical
          from calcutta_entries ce
          inner join calcuttas c on c.id = ce.calcutta_id
          where ce.id = $1
        `,
        [canonicalInserted.rows[0].entry_id],
      );
      assert.equal(canonicalMapping.rows[0].is_canonical, true);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  },
);
