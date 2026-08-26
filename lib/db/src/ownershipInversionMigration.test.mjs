import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

test(
  "Phase 2 ownership inversion preserves primary ownership and installs immutable ledger guards",
  { skip: !databaseUrl },
  async (t) => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      const [migration, view, differences, guards] = await Promise.all([
        pool.query(
          "select count(*)::int as count from app_schema_migrations where version = '0013_ownership_inversion'",
        ),
        pool.query(`
          select c.relkind, v.is_updatable
          from pg_class c
          inner join information_schema.views v
            on v.table_schema = 'public' and v.table_name = c.relname
          where c.oid = 'team_bidders'::regclass
        `),
        pool.query(`
          select count(*)::int as count
          from (
            (
              select team_id, bidder_id, season_id, ownership_share from team_bidders
              except all
              select ce.team_id, p.bidder_id, c.season_id, p.ownership_share
              from positions p
              inner join calcutta_entries ce on ce.id = p.entry_id
              inner join calcuttas c on c.id = ce.calcutta_id
              where p.source = 'primary'
            )
            union all
            (
              select ce.team_id, p.bidder_id, c.season_id, p.ownership_share
              from positions p
              inner join calcutta_entries ce on ce.id = p.entry_id
              inner join calcuttas c on c.id = ce.calcutta_id
              where p.source = 'primary'
              except all
              select team_id, bidder_id, season_id, ownership_share from team_bidders
            )
          ) differences
        `),
        pool.query(`
          select tgname, tgdeferrable, tginitdeferred
          from pg_trigger
          where tgrelid = 'positions'::regclass
            and tgname in (
              'positions_entry_ownership_total',
              'positions_primary_approved_trade_immutable'
            )
          order by tgname
        `),
      ]);

      if (migration.rows[0].count === 0) {
        t.skip("0013_ownership_inversion has not been applied to this database");
        return;
      }

      assert.equal(migration.rows[0].count, 1);
      assert.deepEqual(view.rows[0], { relkind: "v", is_updatable: "NO" });
      assert.equal(differences.rows[0].count, 0);
      assert.deepEqual(guards.rows, [
        {
          tgname: "positions_entry_ownership_total",
          tgdeferrable: true,
          tginitdeferred: true,
        },
        {
          tgname: "positions_primary_approved_trade_immutable",
          tgdeferrable: false,
          tginitdeferred: false,
        },
      ]);

      await client.query("begin");
      await assert.rejects(
        client.query(
          "insert into team_bidders (team_id, bidder_id, season_id, ownership_share) values (0, 0, 0, 1)",
        ),
        /cannot insert into view|not automatically updatable/i,
      );
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  },
);