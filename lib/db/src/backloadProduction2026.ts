import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { pool, syncSeasonPositions } from "./index";
import * as schema from "./schema";

type Snapshot = {
  season: unknown[];
  teams: unknown[];
  bidders: unknown[];
  consortia: unknown[];
  auctions: unknown[];
  teamBidders: unknown[];
  trades: unknown[];
  results: unknown[];
  mtm: unknown[];
  adjustments: unknown[];
};

const SOURCE = "production-2026-backload";
const sourceGaps = [
  "calcuttas",
  "calcutta_entries",
  "payout_rules",
  "period_snapshots",
  "positions",
  "consortium_memberships",
];

function parseSnapshot(raw: unknown): Snapshot {
  if (!raw || typeof raw !== "object") {
    throw new Error("Snapshot must be a JSON object.");
  }
  const snapshot = raw as Partial<Snapshot>;
  const names: Array<keyof Snapshot> = [
    "season",
    "teams",
    "bidders",
    "consortia",
    "auctions",
    "teamBidders",
    "trades",
    "results",
    "mtm",
    "adjustments",
  ];
  for (const name of names) {
    if (!Array.isArray(snapshot[name])) {
      throw new Error(`Snapshot field ${name} must be an array.`);
    }
  }
  return snapshot as Snapshot;
}

function approvedTradeCount(trades: unknown[]): number {
  return trades.filter(
    (trade) =>
      typeof trade === "object" &&
      trade !== null &&
      (trade as { status?: unknown }).status === "approved",
  ).length;
}

async function stage(
  client: PoolClient,
  name: string,
  rows: unknown[],
  definition: string,
) {
  await client.query(
    `CREATE TEMP TABLE ${name} ON COMMIT DROP AS
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${definition})`,
    [JSON.stringify(rows)],
  );
}

async function scalar(
  client: PoolClient,
  query: string,
  values: unknown[] = [],
): Promise<number> {
  const result = await client.query<{ value: string | number }>(query, values);
  return Number(result.rows[0]?.value ?? 0);
}

async function validate(
  client: PoolClient,
  expected: Snapshot,
  targetYear: number,
): Promise<void> {
  const counts = await client.query<{
    auctions: string;
    ownership_rows: string;
    trades: string;
    results: string;
    mtm: string;
    audits: string;
    calcutta_entries: string;
    positions: string;
  }>(`
    SELECT
      (SELECT count(*) FROM team_season_auctions a JOIN seasons s ON s.id = a.season_id WHERE s.year = $1) AS auctions,
      (SELECT count(*) FROM team_bidders b JOIN seasons s ON s.id = b.season_id WHERE s.year = $1) AS ownership_rows,
      (SELECT count(*) FROM trades t JOIN seasons s ON s.id = t.season_id WHERE s.year = $1) AS trades,
      (SELECT count(*) FROM team_results r JOIN seasons s ON s.id = r.season_id WHERE s.year = $1) AS results,
      (SELECT count(*) FROM mtm_snapshots m JOIN seasons s ON s.id = m.season_id WHERE s.year = $1) AS mtm,
      (SELECT count(*) FROM ownership_adjustments a JOIN seasons s ON s.id = a.season_id WHERE s.year = $1) AS audits,
      (SELECT count(*) FROM calcutta_entries ce JOIN calcuttas c ON c.id = ce.calcutta_id JOIN seasons s ON s.id = c.season_id WHERE s.year = $1) AS calcutta_entries,
      (SELECT count(*) FROM positions p JOIN calcutta_entries ce ON ce.id = p.entry_id JOIN calcuttas c ON c.id = ce.calcutta_id JOIN seasons s ON s.id = c.season_id WHERE s.year = $1) AS positions
  `, [targetYear]);
  const actual = counts.rows[0];
  const expectedCounts = {
    auctions: expected.auctions.length,
    ownership_rows: expected.teamBidders.length,
    trades: expected.trades.length,
    results: expected.results.length,
    mtm: expected.mtm.length,
    audits: expected.adjustments.length,
    calcutta_entries: 32,
    positions: expected.teamBidders.length + approvedTradeCount(expected.trades) * 2,
  };
  for (const [name, value] of Object.entries(expectedCounts)) {
    if (Number(actual[name as keyof typeof actual]) !== value) {
      throw new Error(
        `Validation failed for ${name}: expected ${value}, received ${actual[name as keyof typeof actual]}.`,
      );
    }
  }

  const invalidTeams = await scalar(
    client,
    `WITH auction_entries AS (
       SELECT
         auction.team_id,
         count(DISTINCT entry.id) AS entry_count,
         coalesce(sum(position.ownership_share), 0) AS signed_total
       FROM team_season_auctions auction
       JOIN seasons season ON season.id = auction.season_id
       LEFT JOIN calcuttas calcutta
         ON calcutta.season_id = season.id
        AND calcutta.sport = 'NFL'
        AND calcutta.is_canonical = true
       LEFT JOIN calcutta_entries entry
         ON entry.calcutta_id = calcutta.id
        AND entry.team_id = auction.team_id
       LEFT JOIN positions position ON position.entry_id = entry.id
       WHERE season.year = $1
       GROUP BY auction.team_id
     )
     SELECT count(*) AS value
     FROM auction_entries
     WHERE entry_count <> 1
        OR abs(signed_total - 1) > 0.000001`,
    [targetYear],
  );
  if (invalidTeams !== 0) {
    throw new Error(`Validation found ${invalidTeams} teams without 100% signed ownership.`);
  }
}

type BackloadOptions = {
  targetYear: number;
  sourceHash: string;
  requestedBy: string;
  requestId: string;
};

export async function runBackload(
  snapshot: Snapshot,
  { targetYear, sourceHash, requestedBy, requestId }: BackloadOptions,
) {
  if (snapshot.season.length !== 1) {
    throw new Error("Expected exactly one source season.");
  }
  const sourceSeason = snapshot.season[0] as { year?: number };
  if (sourceSeason.year !== targetYear || snapshot.auctions.length !== 32) {
    throw new Error(`Expected a complete ${targetYear} source with 32 auctions.`);
  }

  const client = await pool.connect();
  let inTransaction = false;
  let mode: "imported" | "no-op" = "imported";

  try {
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SELECT pg_advisory_xact_lock(841204, $1)", [targetYear]);
    await stage(client, "st_season", snapshot.season, "id integer, year integer, is_active boolean, is_complete boolean, label text");
    await stage(client, "st_teams", snapshot.teams, "id integer, name text, conference text, division text, bid_amount numeric");
    await stage(client, "st_bidders", snapshot.bidders, "id integer, name text, consortium_id integer");
    await stage(client, "st_consortia", snapshot.consortia, "id integer, name text");
    await stage(client, "st_auctions", snapshot.auctions, "team_id integer, season_id integer, bid_amount numeric");
    await stage(client, "st_team_bidders", snapshot.teamBidders, "team_id integer, bidder_id integer, ownership_share numeric, season_id integer");
    await stage(client, "st_trades", snapshot.trades, "id integer, season_id integer, team_id integer, from_bidder_id integer, to_bidder_id integer, price numeric, trade_date date, notes text, percentage numeric, status text");
    await stage(client, "st_results", snapshot.results, "id integer, team_id integer, season_id integer, wins numeric, pt_diff integer, starting_points numeric, draft_order integer, playoff_berth boolean, div_round boolean, conf_round boolean, sb_berth boolean, win_super_bowl boolean, realized_return numeric, realized_multiple numeric, net_return numeric, net_pct_return numeric, mark_to_market numeric, seed integer, losses integer, ties integer");
    await stage(client, "st_mtm", snapshot.mtm, "id integer, team_id integer, season_id integer, week_num integer, snapshot_date date, mtm_value numeric, snapshot_key text, source text, captured_at timestamptz, market_status text, banked_points numeric, season_equity_points numeric, bonus_equity_points numeric, total_points numeric, normalized_share numeric, market_data jsonb");
    await stage(client, "st_adjustments", snapshot.adjustments, "id integer, season_id integer, team_id integer, source text, note text, owners jsonb, created_at timestamptz");

    await client.query("INSERT INTO teams (name, conference, division, bid_amount) SELECT name, conference, division, bid_amount FROM st_teams ON CONFLICT (name) DO NOTHING");
    await client.query("CREATE TEMP TABLE referenced_bidders ON COMMIT DROP AS SELECT bidder_id AS source_id FROM st_team_bidders UNION SELECT from_bidder_id FROM st_trades UNION SELECT to_bidder_id FROM st_trades");
    await client.query("INSERT INTO bidders (name) SELECT DISTINCT b.name FROM st_bidders b JOIN referenced_bidders rb ON rb.source_id = b.id ON CONFLICT (name) DO NOTHING");
    await client.query("INSERT INTO consortia (name) SELECT DISTINCT c.name FROM st_consortia c JOIN st_bidders b ON b.consortium_id = c.id JOIN referenced_bidders rb ON rb.source_id = b.id ON CONFLICT DO NOTHING");
    await client.query("INSERT INTO seasons (year, is_active, is_complete, label) SELECT year, is_active, is_complete, label FROM st_season ON CONFLICT (year) DO UPDATE SET is_active = EXCLUDED.is_active, is_complete = EXCLUDED.is_complete, label = EXCLUDED.label");
    await client.query("CREATE TEMP TABLE target_season ON COMMIT DROP AS SELECT s.id, s.year FROM seasons s JOIN st_season ss ON ss.year = s.year");
    await client.query("CREATE TEMP TABLE team_map ON COMMIT DROP AS SELECT st.id AS source_id, t.id AS target_id FROM st_teams st JOIN teams t ON t.name = st.name");
    await client.query("CREATE TEMP TABLE bidder_map ON COMMIT DROP AS SELECT st.id AS source_id, b.id AS target_id FROM st_bidders st JOIN bidders b ON b.name = st.name");
    await client.query("CREATE TEMP TABLE consortium_map ON COMMIT DROP AS SELECT st.id AS source_id, c.id AS target_id FROM st_consortia st JOIN consortia c ON lower(c.name) = lower(st.name)");

    if (await scalar(client, "SELECT count(*) AS value FROM team_map") !== 32) throw new Error("Team identity mapping is incomplete.");
    const referencedBidders = await scalar(client, "SELECT count(*) AS value FROM referenced_bidders");
    const targetSeasonResult = await client.query<{ id: number }>(
      "SELECT id FROM target_season",
    );
    const targetSeasonId = targetSeasonResult.rows[0]?.id;
    if (!targetSeasonId) throw new Error("Unable to resolve the target 2026 season.");
    if (await scalar(client, "SELECT count(*) AS value FROM bidder_map bm JOIN referenced_bidders rb ON rb.source_id = bm.source_id") !== referencedBidders) throw new Error("Bidder identity mapping is incomplete.");
    if (await scalar(client, "SELECT count(*) AS value FROM consortium_map") < 1) throw new Error("Consortium identity mapping is empty.");
    if (await scalar(client, "SELECT count(*) AS value FROM st_adjustments a CROSS JOIN LATERAL jsonb_array_elements(a.owners -> 'owners') AS item LEFT JOIN bidder_map bm ON bm.source_id = NULLIF(item ->> 'bidderId', '')::integer WHERE bm.target_id IS NULL") !== 0) throw new Error("Ownership audit contains an unmapped bidder reference.");
    if (await scalar(client, "SELECT count(*) AS value FROM import_runs ir JOIN target_season ts ON ts.id = ir.season_id WHERE ir.source = $1 AND ir.source_hash = $2", [SOURCE, sourceHash]) > 0) {
      mode = "no-op";
    } else {
      if (await scalar(client, "SELECT count(*) AS value FROM trades t JOIN target_season ts ON ts.id = t.season_id WHERE t.status = 'approved'") > 0) {
        throw new Error("A changed source cannot replace a season that already has approved trades.");
      }
      const membershipConflicts = await scalar(client, "SELECT count(*) AS value FROM st_bidders sb JOIN referenced_bidders rb ON rb.source_id = sb.id JOIN bidder_map bm ON bm.source_id = sb.id JOIN consortium_map scm ON scm.source_id = sb.consortium_id JOIN consortium_memberships cm ON cm.bidder_id = bm.target_id AND cm.to_date IS NULL WHERE sb.consortium_id IS NOT NULL AND cm.consortium_id <> scm.target_id");
      if (membershipConflicts !== 0) throw new Error("Existing active consortium memberships differ from production.");

      await client.query("DELETE FROM calcuttas WHERE season_id = (SELECT id FROM target_season)");
      await client.query("DELETE FROM ownership_adjustments WHERE season_id = (SELECT id FROM target_season)");
      await client.query("DELETE FROM mtm_snapshots WHERE season_id = (SELECT id FROM target_season)");
      await client.query("DELETE FROM trades WHERE season_id = (SELECT id FROM target_season)");
      await client.query("DELETE FROM team_results WHERE season_id = (SELECT id FROM target_season)");
      await client.query("DELETE FROM team_bidders WHERE season_id = (SELECT id FROM target_season)");
      await client.query("DELETE FROM team_season_auctions WHERE season_id = (SELECT id FROM target_season)");
      await client.query("DELETE FROM import_runs WHERE season_id = (SELECT id FROM target_season)");

      await client.query("INSERT INTO consortium_memberships (bidder_id, consortium_id, from_date) SELECT bm.target_id, cm.target_id, DATE '2026-08-01' FROM st_bidders sb JOIN referenced_bidders rb ON rb.source_id = sb.id JOIN bidder_map bm ON bm.source_id = sb.id JOIN consortium_map cm ON cm.source_id = sb.consortium_id WHERE sb.consortium_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM consortium_memberships existing WHERE existing.bidder_id = bm.target_id AND existing.to_date IS NULL) ON CONFLICT DO NOTHING");
      await client.query("INSERT INTO team_season_auctions (team_id, season_id, bid_amount) SELECT tm.target_id, ts.id, a.bid_amount FROM st_auctions a JOIN team_map tm ON tm.source_id = a.team_id CROSS JOIN target_season ts");
      await client.query("INSERT INTO team_bidders (team_id, bidder_id, season_id, ownership_share) SELECT tm.target_id, bm.target_id, ts.id, tb.ownership_share FROM st_team_bidders tb JOIN team_map tm ON tm.source_id = tb.team_id JOIN bidder_map bm ON bm.source_id = tb.bidder_id CROSS JOIN target_season ts");
      await client.query("INSERT INTO team_results (team_id, season_id, wins, losses, ties, pt_diff, starting_points, draft_order, playoff_berth, div_round, conf_round, sb_berth, win_super_bowl, seed, realized_return, realized_multiple, net_return, net_pct_return, mark_to_market) SELECT tm.target_id, ts.id, r.wins, r.losses, r.ties, r.pt_diff, r.starting_points, r.draft_order, r.playoff_berth, r.div_round, r.conf_round, r.sb_berth, r.win_super_bowl, r.seed, r.realized_return, r.realized_multiple, r.net_return, r.net_pct_return, r.mark_to_market FROM st_results r JOIN team_map tm ON tm.source_id = r.team_id CROSS JOIN target_season ts");
      await client.query("INSERT INTO trades (season_id, team_id, from_bidder_id, to_bidder_id, price, percentage, status, decision_at, decision_source, trade_date, notes) SELECT ts.id, tm.target_id, seller.target_id, buyer.target_id, tr.price, tr.percentage, tr.status, NULL, NULL, tr.trade_date, tr.notes FROM st_trades tr JOIN team_map tm ON tm.source_id = tr.team_id JOIN bidder_map seller ON seller.source_id = tr.from_bidder_id JOIN bidder_map buyer ON buyer.source_id = tr.to_bidder_id CROSS JOIN target_season ts");
      await client.query("INSERT INTO mtm_snapshots (team_id, season_id, week_num, snapshot_date, mtm_value, snapshot_key, source, captured_at, market_status, banked_points, season_equity_points, bonus_equity_points, total_points, normalized_share, market_data) SELECT tm.target_id, ts.id, m.week_num, m.snapshot_date, m.mtm_value, m.snapshot_key, m.source, m.captured_at, m.market_status, m.banked_points, m.season_equity_points, m.bonus_equity_points, m.total_points, m.normalized_share, m.market_data FROM st_mtm m JOIN team_map tm ON tm.source_id = m.team_id CROSS JOIN target_season ts");
      await client.query("INSERT INTO ownership_adjustments (season_id, team_id, source, note, owners, created_at) SELECT ts.id, tm.target_id, a.source, a.note, CASE WHEN jsonb_typeof(a.owners -> 'owners') = 'array' THEN jsonb_set(a.owners, '{owners}', COALESCE((SELECT jsonb_agg(jsonb_set(item, '{bidderId}', to_jsonb(bm.target_id))) FROM jsonb_array_elements(a.owners -> 'owners') AS item JOIN bidder_map bm ON bm.source_id = NULLIF(item ->> 'bidderId', '')::integer), '[]'::jsonb)) ELSE a.owners END, a.created_at FROM st_adjustments a JOIN team_map tm ON tm.source_id = a.team_id CROSS JOIN target_season ts");
      await syncSeasonPositions(drizzle(client, { schema }), targetSeasonId);
    }

    await validate(client, snapshot, targetYear);
    if (mode === "imported") {
      await client.query("INSERT INTO import_runs (season_id, source, source_hash, imported_teams, imported_owners, requested_by, request_id) SELECT ts.id, $1, $2, 32, $3, $4, $5 FROM target_season ts", [SOURCE, sourceHash, referencedBidders, requestedBy, requestId]);
    }
    await client.query("COMMIT");
    inTransaction = false;
    return {
      mode,
      source: SOURCE,
      targetYear,
      sourceHash,
      sourceGaps,
      imported: {
        teams: 32,
        bidders: referencedBidders,
        auctions: snapshot.auctions.length,
        ownershipRows: snapshot.teamBidders.length,
        trades: snapshot.trades.length,
        results: snapshot.results.length,
        mtmSnapshots: snapshot.mtm.length,
        ownershipAdjustments: snapshot.adjustments.length,
      },
      derived: {
        calcuttaEntries: 32,
        positions:
          snapshot.teamBidders.length + approvedTradeCount(snapshot.trades) * 2,
      },
      validated: true,
    };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const snapshotPath = process.argv.slice(2).find((argument) => argument !== "--");
  if (!snapshotPath) {
    throw new Error(
      "Usage: pnpm --filter @workspace/db exec tsx ../../lib/db/src/backloadProduction2026.ts <snapshot.json>",
    );
  }
  const snapshot = parseSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  try {
    const result = await runBackload(snapshot, {
      targetYear: 2026,
      sourceHash,
      requestedBy: process.env.IMPORT_REQUESTED_BY ?? "staging-backload",
      requestId:
        process.env.IMPORT_REQUEST_ID ??
        `production-2026-${sourceHash.slice(0, 12)}`,
    });
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("backloadProduction2026.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}