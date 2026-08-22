import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { runBackload } from "./backloadProduction2026";
import { closeDatabasePool } from "./index";

const databaseUrl = process.env.DATABASE_URL;

function makeSnapshot(
  year: number,
  options: { invalidPrimaryOwner?: boolean; missingPrimaryOwner?: boolean } = {},
) {
  const prefix = `Atomic backload rollback ${year}`;
  return {
    season: [
      {
        id: 1,
        year,
        is_active: false,
        is_complete: false,
        label: `${year} rollback fixture`,
      },
    ],
    teams: Array.from({ length: 32 }, (_, index) => ({
      id: index + 1,
      name: `${prefix} Team ${index + 1}`,
      conference: index < 16 ? "AFC" : "NFC",
      division: "Test",
      bid_amount: "100.00",
    })),
    bidders: Array.from({ length: 32 }, (_, index) => ({
      id: index + 1,
      name: `${prefix} Bidder ${index + 1}`,
      consortium_id: 1,
    })),
    consortia: [{ id: 1, name: `${prefix} Consortium` }],
    auctions: Array.from({ length: 32 }, (_, index) => ({
      team_id: index + 1,
      season_id: 1,
      bid_amount: "100.00",
    })),
    teamBidders: Array.from({ length: 32 }, (_, index) => ({
      team_id: index + 1,
      bidder_id: index + 1,
      season_id: 1,
      ownership_share:
        options.invalidPrimaryOwner && index === 0 ? "0.5000" : "1.0000",
    })).filter((row) => !options.missingPrimaryOwner || row.team_id !== 1),
    trades: [],
    results: [],
    mtm: [],
    adjustments: [],
  };
}

after(async () => {
  await closeDatabasePool();
});

test(
  "rolls back missing or invalid primary ownership without touching another season",
  { skip: !databaseUrl },
  async () => {
    const verificationPool = new Pool({ connectionString: databaseUrl });

    try {
      const before = await verificationPool.query<{ count: string }>(
        `SELECT count(*) AS count
         FROM team_season_auctions auction
         JOIN seasons season ON season.id = auction.season_id
         WHERE season.year = 2025`,
      );

      const fixtures = [
        {
          snapshot: makeSnapshot(3_000 + Math.floor(Math.random() * 2_000), {
            invalidPrimaryOwner: true,
          }),
          expectedError: /Signed positions.*exactly 1\.000000/,
        },
        {
          snapshot: makeSnapshot(
            5_001 + Math.floor(Math.random() * 2_000),
            { missingPrimaryOwner: true },
          ),
          expectedError: /Validation found 1 teams without 100% signed ownership/,
        },
      ];

      for (const fixture of fixtures) {
        const targetYear = fixture.snapshot.season[0]?.year as number;
        const sourceHash = createHash("sha256")
          .update(JSON.stringify(fixture.snapshot))
          .digest("hex");
        await assert.rejects(
          runBackload(fixture.snapshot, {
            targetYear,
            sourceHash,
            requestedBy: "backload-rollback-test",
            requestId: `rollback-${targetYear}`,
          }),
          fixture.expectedError,
        );

        const after = await verificationPool.query<{
          season_rows: string;
          import_runs: string;
          auctions_2025: string;
        }>(
          `SELECT
             (SELECT count(*) FROM seasons WHERE year = $1) AS season_rows,
             (SELECT count(*)
                FROM import_runs import_run
                JOIN seasons season ON season.id = import_run.season_id
               WHERE season.year = $1) AS import_runs,
             (SELECT count(*)
                FROM team_season_auctions auction
                JOIN seasons season ON season.id = auction.season_id
               WHERE season.year = 2025) AS auctions_2025`,
          [targetYear],
        );
        const actual = after.rows[0];
        assert.equal(actual?.season_rows, "0");
        assert.equal(actual?.import_runs, "0");
        assert.equal(actual?.auctions_2025, before.rows[0]?.count);
      }
    } finally {
      await verificationPool.end();
    }
  },
);

test(
  "replays a successful source hash as a no-op through the same pool",
  { skip: !databaseUrl },
  async () => {
    const targetYear = 8_001 + Math.floor(Math.random() * 1_000);
    const snapshot = makeSnapshot(targetYear);
    const sourceHash = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    const verificationPool = new Pool({ connectionString: databaseUrl });
    const prefix = `Atomic backload rollback ${targetYear}`;

    try {
      const options = {
        targetYear,
        sourceHash,
        requestedBy: "backload-idempotency-test",
        requestId: `retry-${targetYear}`,
      };
      const first = await runBackload(snapshot, options);
      const second = await runBackload(snapshot, options);
      assert.equal(first.mode, "imported");
      assert.equal(second.mode, "no-op");

      const counts = await verificationPool.query<{
        auctions: string;
        import_runs: string;
      }>(
        `SELECT
           (SELECT count(*)
              FROM team_season_auctions auction
              JOIN seasons season ON season.id = auction.season_id
             WHERE season.year = $1) AS auctions,
           (SELECT count(*)
              FROM import_runs import_run
              JOIN seasons season ON season.id = import_run.season_id
             WHERE season.year = $1) AS import_runs`,
        [targetYear],
      );
      assert.equal(counts.rows[0]?.auctions, "32");
      assert.equal(counts.rows[0]?.import_runs, "1");
    } finally {
      await verificationPool.query(
        "DELETE FROM import_runs WHERE season_id IN (SELECT id FROM seasons WHERE year = $1)",
        [targetYear],
      );
      await verificationPool.query("DELETE FROM seasons WHERE year = $1", [
        targetYear,
      ]);
      await verificationPool.query("DELETE FROM consortia WHERE name = $1", [
        `${prefix} Consortium`,
      ]);
      await verificationPool.query("DELETE FROM bidders WHERE name LIKE $1", [
        `${prefix} Bidder %`,
      ]);
      await verificationPool.query("DELETE FROM teams WHERE name LIKE $1", [
        `${prefix} Team %`,
      ]);
      await verificationPool.end();
    }
  },
);