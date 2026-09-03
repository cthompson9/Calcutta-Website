import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { phase1ReleaseSafetyMigration } from "./migrations/0024Phase1ReleaseSafety.ts";
import { platformSchemaMigration } from "./migrations/0012PlatformSchema.ts";
import { ownershipInversionMigration } from "./migrations/0013OwnershipInversion.ts";
import { mtmEntryScopeMigration } from "./migrations/0014MtmEntryScope.ts";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

async function withPhase1SafetyFixture(run) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `phase1_safety_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}, public`);
    await client.query(`
      create table seasons (
        id integer primary key,
        year integer not null
      );
      create table calcuttas (
        id integer primary key,
        season_id integer not null,
        sport text not null,
        is_canonical boolean not null
      );
      create table calcutta_entries (
        id integer primary key,
        calcutta_id integer not null,
        team_id integer not null
      );
      create table trades (
        id integer primary key,
        entry_id integer not null,
        team_id integer not null,
        season_id integer not null
      );
      create table mtm_snapshots (
        id integer primary key,
        entry_id integer not null,
        team_id integer not null,
        season_id integer not null
      );
      create table positions (
        id integer primary key,
        entry_id integer not null,
        bidder_id integer not null,
        ownership_share numeric(9, 6) not null,
        source text not null
      );
      create table calcutta_rules (
        id serial primary key,
        calcutta_id integer not null,
        rule_name text not null,
        rule_type text,
        value numeric(16, 6),
        multiplier numeric(16, 6),
        description text,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create unique index calcutta_rules_calcutta_rule_idx
        on calcutta_rules(calcutta_id, rule_name);

      insert into seasons values (1, 2025), (2, 2026);
      insert into calcuttas values
        (10, 1, 'NFL', true),
        (20, 2, 'NFL', true);
      insert into calcutta_entries values
        (100, 10, 1000),
        (200, 20, 2000);
      insert into trades values
        (1, 100, 1000, 1),
        (2, 200, 2000, 2);
      insert into mtm_snapshots values
        (1, 100, 1000, 1),
        (2, 200, 2000, 2);
      insert into positions values
        (1, 100, 500, 1.000000, 'primary'),
        (2, 200, 600, 1.000000, 'primary');
      insert into calcutta_rules (
        calcutta_id, rule_name, rule_type, value, description
      ) values
        (10, 'banked', 'points', 150, 'legacy seed'),
        (10, 'win', 'points', 10, 'legacy seed'),
        (20, 'banked', 'points', 150, 'legacy seed'),
        (20, 'win', 'points', 10, 'legacy seed');

      create view team_bidders as
        select
          ce.team_id,
          p.bidder_id,
          c.season_id,
          p.ownership_share
        from positions p
        inner join calcutta_entries ce on ce.id = p.entry_id
        inner join calcuttas c on c.id = ce.calcutta_id
        where p.source = 'primary';
    `);
    await run(client);
  } finally {
    await client.query("reset search_path").catch(() => {});
    await client.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    client.release();
    await pool.end();
  }
}

async function withOwnershipInversionFixture({ populated = true } = {}, run) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `ownership_inversion_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}, public`);
    await client.query(`
      create table calcuttas (
        id integer primary key,
        season_id integer not null
      );
      create table calcutta_entries (
        id integer primary key,
        calcutta_id integer not null,
        team_id integer not null
      );
      create table trades (
        id integer primary key,
        entry_id integer not null,
        status text not null
      );
      create table positions (
        id integer primary key,
        entry_id integer not null,
        bidder_id integer not null,
        ownership_share numeric(9, 6) not null,
        source text not null
      );
      create table team_bidders (
        team_id integer not null,
        bidder_id integer not null,
        season_id integer not null,
        ownership_share numeric(9, 6) not null
      );
    `);
    if (populated) {
      await client.query(`
        insert into calcuttas values (10, 1);
        insert into calcutta_entries values (100, 10, 1000);
        insert into positions values
          (1, 100, 500, 0.600000, 'primary'),
          (2, 100, 600, 0.400000, 'primary');
        insert into team_bidders values
          (1000, 500, 1, 0.600000),
          (1000, 600, 1, 0.400000);
      `);
    }
    await run(client);
  } finally {
    await client.query("reset search_path").catch(() => {});
    await client.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    client.release();
    await pool.end();
  }
}

async function withMtmScopeFixture({ resolvable = true } = {}, run) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `mtm_scope_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}, public`);
    await client.query(`
      create table calcuttas (
        id integer primary key,
        season_id integer not null,
        sport text not null,
        is_canonical boolean not null
      );
      create table calcutta_entries (
        id integer primary key,
        calcutta_id integer not null,
        team_id integer not null
      );
      create table mtm_snapshots (
        id integer primary key,
        team_id integer not null,
        season_id integer not null,
        snapshot_date date not null,
        snapshot_key text
      );
      insert into calcuttas values (10, 1, 'NFL', true);
      insert into mtm_snapshots values
        (1, 1000, 1, '2026-08-01', 'week-0'),
        (2, 1000, 1, '2026-08-02', null);
    `);
    if (resolvable) {
      await client.query("insert into calcutta_entries values (100, 10, 1000)");
    }
    await run(client);
  } finally {
    await client.query("reset search_path").catch(() => {});
    await client.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    client.release();
    await pool.end();
  }
}

test(
  "0024 preserves protected rows, canonicalizes rules, and validates ownership coverage",
  { skip: !databaseUrl },
  async () => {
    await withPhase1SafetyFixture(async (client) => {
      await client.query("begin");
      try {
        await client.query(phase1ReleaseSafetyMigration.sql);
        const counts = await client.query(`
          select
            (select count(*)::int from trades) as trades,
            (select count(*)::int from mtm_snapshots) as mtm,
            (select count(*)::int from positions) as positions,
            (select count(*)::int from team_bidders) as team_bidders,
            (select count(*)::int from calcutta_rules) as rules
        `);
        assert.deepEqual(counts.rows[0], {
          trades: 2,
          mtm: 2,
          positions: 2,
          team_bidders: 2,
          rules: 18,
        });

        const ruleSummary = await client.query(`
          select
            c.season_id,
            count(*)::int as required_count,
            count(*) filter (
              where r.value is null and r.multiplier is null
            )::int as fully_null_count,
            max(r.value) filter (where r.rule_name = 'banked_points')::text as banked,
            max(r.value) filter (where r.rule_name = 'regular_season_win')::text as win,
            max(r.multiplier) filter (
              where r.rule_name = 'marquee_point_differential'
            )::text as marquee
          from calcutta_rules r
          inner join calcuttas c on c.id = r.calcutta_id
          group by c.season_id
          order by c.season_id
        `);
        assert.deepEqual(ruleSummary.rows, [
          {
            season_id: 1,
            required_count: 9,
            fully_null_count: 6,
            banked: "150.000000",
            win: "10.000000",
            marquee: "2.000000",
          },
          {
            season_id: 2,
            required_count: 9,
            fully_null_count: 6,
            banked: "150.000000",
            win: "10.000000",
            marquee: "2.000000",
          },
        ]);
      } finally {
        await client.query("rollback");
      }
    });
  },
);

test(
  "0024 aborts atomically when protected entry mappings do not round-trip",
  { skip: !databaseUrl },
  async () => {
    await withPhase1SafetyFixture(async (client) => {
      await client.query("update trades set team_id = 9999 where id = 1");
      await client.query("begin");
      try {
        await assert.rejects(
          client.query(phase1ReleaseSafetyMigration.sql),
          /trade entry does not round-trip/i,
        );
      } finally {
        await client.query("rollback");
      }
      assert.equal(
        (await client.query("select count(*)::int as count from calcutta_rules")).rows[0].count,
        4,
      );
    });
  },
);

test(
  "0013 preserves the populated legacy ownership rows when replacing the table with a view",
  { skip: !databaseUrl },
  async () => {
    await withOwnershipInversionFixture({ populated: true }, async (client) => {
      const before = await client.query(
        "select * from team_bidders order by team_id, bidder_id",
      );
      await client.query("begin");
      try {
        await client.query(ownershipInversionMigration.sql);
        const relation = await client.query(`
          select relkind
          from pg_class
          where oid = 'team_bidders'::regclass
        `);
        const after = await client.query(
          "select * from team_bidders order by team_id, bidder_id",
        );
        assert.equal(relation.rows[0].relkind, "v");
        assert.deepEqual(after.rows, before.rows);
      } finally {
        await client.query("rollback");
      }
    });
  },
);

test(
  "0013 rejects an empty ownership replacement and leaves the table intact",
  { skip: !databaseUrl },
  async () => {
    await withOwnershipInversionFixture({ populated: false }, async (client) => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query(ownershipInversionMigration.sql),
          /unexpectedly empty|no populated primary positions/i,
        );
      } finally {
        await client.query("rollback");
      }
      const relation = await client.query(`
        select relkind
        from pg_class
        where oid = 'team_bidders'::regclass
      `);
      assert.equal(relation.rows[0].relkind, "r");
    });
  },
);

test(
  "0014 preserves every MTM row and round-trips entry identity before tightening",
  { skip: !databaseUrl },
  async () => {
    await withMtmScopeFixture({ resolvable: true }, async (client) => {
      const before = await client.query(
        "select id, team_id, season_id, snapshot_date, snapshot_key from mtm_snapshots order by id",
      );
      await client.query("begin");
      try {
        await client.query(mtmEntryScopeMigration.sql);
        const after = await client.query(`
          select m.id, m.team_id, m.season_id, m.snapshot_date, m.snapshot_key
          from mtm_snapshots m
          inner join calcutta_entries ce on ce.id = m.entry_id
          inner join calcuttas c on c.id = ce.calcutta_id
          where ce.team_id = m.team_id and c.season_id = m.season_id
          order by m.id
        `);
        const nullable = await client.query(`
          select is_nullable
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'mtm_snapshots'
            and column_name = 'entry_id'
        `);
        assert.deepEqual(after.rows, before.rows);
        assert.equal(nullable.rows[0].is_nullable, "NO");
      } finally {
        await client.query("rollback");
      }
    });
  },
);

test(
  "0014 aborts unresolved MTM backfills before tightening and rolls back its DDL",
  { skip: !databaseUrl },
  async () => {
    await withMtmScopeFixture({ resolvable: false }, async (client) => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query(mtmEntryScopeMigration.sql),
          /no unambiguous canonical NFL Calcutta entry/i,
        );
      } finally {
        await client.query("rollback");
      }
      const entryColumn = await client.query(`
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'mtm_snapshots'
          and column_name = 'entry_id'
      `);
      assert.equal(entryColumn.rowCount, 0);
      assert.equal(
        (await client.query("select count(*)::int as count from mtm_snapshots")).rows[0].count,
        2,
      );
    });
  },
);

test("Phase 1 migration SQL contains the required destructive-operation guards", () => {
  const sql = [
    platformSchemaMigration.sql,
    ownershipInversionMigration.sql,
    mtmEntryScopeMigration.sql,
    phase1ReleaseSafetyMigration.sql,
  ].join("\n");

  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.match(platformSchemaMigration.sql, /trades where entry_id is null/i);
  assert.doesNotMatch(
    platformSchemaMigration.sql,
    /entry_id integer not null references calcutta_entries/i,
  );
  assert.match(mtmEntryScopeMigration.sql, /mtm_snapshots where entry_id is null/i);
  assert.match(ownershipInversionMigration.sql, /not exists \(select 1 from team_bidders\)/i);
  assert.match(ownershipInversionMigration.sql, /count\(distinct \(team_id, season_id\)\)/i);
  assert.match(ownershipInversionMigration.sql, /except all/i);
});