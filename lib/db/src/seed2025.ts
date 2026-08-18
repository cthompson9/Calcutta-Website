/**
 * Seeds 2025 season data: seasons table, team_results, and backfills team_bidders.season_id.
 * Run: pnpm --filter @workspace/db run seed2025
 */
import { db } from "./index";
import { seasonsTable, teamResultsTable, teamBiddersTable, teamsTable } from "./schema";
import { eq, sql } from "drizzle-orm";

async function main() {
  console.log("Seeding seasons...");

  // Upsert 2025 (completed) and 2026 (active)
  const [s2025] = await db
    .insert(seasonsTable)
    .values({ year: 2025, isActive: false, isComplete: true, label: "2025 Season" })
    .onConflictDoUpdate({ target: seasonsTable.year, set: { isComplete: true, label: "2025 Season" } })
    .returning();
  const [s2026] = await db
    .insert(seasonsTable)
    .values({ year: 2026, isActive: true, isComplete: false, label: "2026 Season" })
    .onConflictDoUpdate({ target: seasonsTable.year, set: { isActive: true, label: "2026 Season" } })
    .returning();
  console.log(`  Season 2025 id=${s2025.id}, Season 2026 id=${s2026.id}`);

  // Backfill existing team_bidders to season 2025
  await db
    .update(teamBiddersTable)
    .set({ seasonId: s2025.id })
    .where(sql`${teamBiddersTable.seasonId} IS NULL`);
  console.log("  Backfilled team_bidders.season_id → 2025");

  // Build team name → id map
  const allTeams = await db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable);
  const teamMap = new Map(allTeams.map((t) => [t.name, t.id]));

  // 2025 results data (from Calcutta Returns sheet)
  // Columns: teamName, wins, ptDiff, playoffBerth, divRound, confRound, sbBerth, winSuperBowl, realizedReturn, markToMarket
  const results2025: Array<{
    teamName: string;
    wins: number;
    ptDiff: number;
    startingPoints: number;
    draftOrder?: number;
    playoffBerth: boolean;
    divRound: boolean;
    confRound: boolean;
    sbBerth: boolean;
    winSuperBowl: boolean;
    realizedReturn: number;
    markToMarket: number;
  }> = [
    // AFC East
    { teamName: "Buffalo Bills",          wins: 12,   ptDiff: 110,  startingPoints: 150, draftOrder: 1,  playoffBerth: true,  divRound: true,  confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 2241.593695,  markToMarket: -988.406305  },
    { teamName: "New York Jets",           wins: 3,    ptDiff: -224, startingPoints: 150, draftOrder: 2,  playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: -186.094571,  markToMarket: -876.094571  },
    { teamName: "Miami Dolphins",          wins: 7,    ptDiff: -113, startingPoints: 150, draftOrder: 3,  playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 452.548161,   markToMarket: -657.451839  },
    { teamName: "New England Patriots",    wins: 14,   ptDiff: 208,  startingPoints: 150, draftOrder: 4,  playoffBerth: true,  divRound: true,  confRound: true,  sbBerth: true,  winSuperBowl: false, realizedReturn: 5278.318739,  markToMarket: 4348.318739  },
    // AFC North
    { teamName: "Cincinnati Bengals",      wins: 6,    ptDiff: -83,  startingPoints: 150, draftOrder: 5,  playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 537.136603,   markToMarket: -1482.863398 },
    { teamName: "Baltimore Ravens",        wins: 8,    ptDiff: 32,   startingPoints: 150, draftOrder: 6,  playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1108.108581,  markToMarket: -1871.891419 },
    { teamName: "Cleveland Browns",        wins: 5,    ptDiff: -104, startingPoints: 150, draftOrder: 7,  playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 406.024518,   markToMarket: -33.975482   },
    { teamName: "Pittsburgh Steelers",     wins: 10,   ptDiff: 1,    startingPoints: 150, draftOrder: 8,  playoffBerth: true,  divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1273.056042,  markToMarket: 103.056042   },
    // AFC South
    { teamName: "Jacksonville Jaguars",   wins: 13,   ptDiff: 113,  startingPoints: 150, draftOrder: 9,  playoffBerth: true,  divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1873.633975,  markToMarket: 713.633975   },
    { teamName: "Tennessee Titans",        wins: 3,    ptDiff: -194, startingPoints: 150, draftOrder: 10, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: -59.211909,   markToMarket: -719.211909  },
    { teamName: "Indianapolis Colts",      wins: 8,    ptDiff: 39,   startingPoints: 150, draftOrder: 11, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1137.714536,  markToMarket: 127.714536   },
    { teamName: "Houston Texans",          wins: 12,   ptDiff: 118,  startingPoints: 150, draftOrder: 12, playoffBerth: true,  divRound: true,  confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 2275.429072,  markToMarket: 655.429072   },
    // AFC West
    { teamName: "Kansas City Chiefs",      wins: 6,    ptDiff: 52,   startingPoints: 150, draftOrder: 13, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1108.108581,  markToMarket: -1661.891419 },
    { teamName: "Los Angeles Chargers",    wins: 11,   ptDiff: 86,   startingPoints: 150, draftOrder: 14, playoffBerth: true,  divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1674.851138,  markToMarket: -55.148862   },
    { teamName: "Denver Broncos",          wins: 14,   ptDiff: 128,  startingPoints: 150, draftOrder: 15, playoffBerth: true,  divRound: true,  confRound: true,  sbBerth: false, winSuperBowl: false, realizedReturn: 3248.196147,  markToMarket: 1558.196147  },
    { teamName: "Las Vegas Raiders",       wins: 3,    ptDiff: -222, startingPoints: 150, draftOrder: 16, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: -177.635727,  markToMarket: -1087.635727 },
    // NFC East
    { teamName: "Philadelphia Eagles",     wins: 11,   ptDiff: 50,   startingPoints: 150, draftOrder: 17, playoffBerth: true,  divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1522.591944,  markToMarket: -1467.408056 },
    { teamName: "Dallas Cowboys",          wins: 7.5,  ptDiff: -49,  startingPoints: 150, draftOrder: 18, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 744.378284,   markToMarket: -265.621716  },
    { teamName: "New York Giants",         wins: 4,    ptDiff: -72,  startingPoints: 150, draftOrder: 19, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 499.071804,   markToMarket: -220.928196  },
    { teamName: "Washington Commanders",   wins: 5,    ptDiff: -172, startingPoints: 150, draftOrder: 20, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 118.423818,   markToMarket: -1741.576182 },
    // NFC North
    { teamName: "Detroit Lions",           wins: 9,    ptDiff: 65,   startingPoints: 150, draftOrder: 21, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1289.973730,  markToMarket: -1450.026270 },
    { teamName: "Minnesota Vikings",       wins: 9,    ptDiff: -7,   startingPoints: 150, draftOrder: 22, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 985.455342,   markToMarket: -624.544658  },
    { teamName: "Green Bay Packers",       wins: 9.5,  ptDiff: 31,   startingPoints: 150, draftOrder: 23, playoffBerth: true,  divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1378.791594,  markToMarket: -461.208406  },
    { teamName: "Chicago Bears",           wins: 11,   ptDiff: 35,   startingPoints: 150, draftOrder: 24, playoffBerth: true,  divRound: true,  confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 1882.092820,  markToMarket: 702.092820   },
    // NFC South
    { teamName: "New Orleans Saints",      wins: 6,    ptDiff: -77,  startingPoints: 150, draftOrder: 25, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 562.513135,   markToMarket: 92.513135    },
    { teamName: "Atlanta Falcons",         wins: 8,    ptDiff: -34,  startingPoints: 150, draftOrder: 26, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 828.966725,   markToMarket: -181.033275  },
    { teamName: "Carolina Panthers",       wins: 8,    ptDiff: -82,  startingPoints: 150, draftOrder: 27, playoffBerth: true,  divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 837.425569,   markToMarket: -32.574431   },
    { teamName: "Tampa Bay Buccaneers",    wins: 8,    ptDiff: -71,  startingPoints: 150, draftOrder: 28, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 672.478109,   markToMarket: -1167.521891 },
    // NFC West
    { teamName: "San Francisco 49ers",     wins: 12,   ptDiff: 105,  startingPoints: 150, draftOrder: 29, playoffBerth: true,  divRound: true,  confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 2220.446585,  markToMarket: 220.446585   },
    { teamName: "Seattle Seahawks",        wins: 14,   ptDiff: 237,  startingPoints: 150, draftOrder: 30, playoffBerth: true,  divRound: true,  confRound: true,  sbBerth: true,  winSuperBowl: true,  realizedReturn: 8784.509632,  markToMarket: 7744.509632  },
    { teamName: "Los Angeles Rams",        wins: 12,   ptDiff: 220,  startingPoints: 150, draftOrder: 31, playoffBerth: true,  divRound: true,  confRound: true,  sbBerth: false, winSuperBowl: false, realizedReturn: 3552.714536,  markToMarket: 1852.714536  },
    { teamName: "Arizona Cardinals",       wins: 3,    ptDiff: -126, startingPoints: 150, draftOrder: 32, playoffBerth: false, divRound: false, confRound: false, sbBerth: false, winSuperBowl: false, realizedReturn: 228.388792,   markToMarket: -1071.611208 },
  ];

  // Payout amounts
  const PLAYOFF_BERTH = 50;
  const DIV_ROUND = 100;
  const CONF_ROUND = 200;
  const SB_BERTH = 400;
  const WIN_SB = 800;

  console.log(`Seeding ${results2025.length} team results for 2025...`);
  for (const r of results2025) {
    const teamId = teamMap.get(r.teamName);
    if (!teamId) {
      console.warn(`  ⚠ Team not found: ${r.teamName}`);
      continue;
    }

    // Get the effective cost for this team
    const teamRow = await db.select().from(teamsTable).where(eq(teamsTable.id, teamId)).limit(1);
    const cost = parseFloat(teamRow[0]?.bidAmount ?? "0");

    const payouts =
      (r.playoffBerth ? PLAYOFF_BERTH : 0) +
      (r.divRound ? DIV_ROUND : 0) +
      (r.confRound ? CONF_ROUND : 0) +
      (r.sbBerth ? SB_BERTH : 0) +
      (r.winSuperBowl ? WIN_SB : 0);

    const realizedReturn = r.realizedReturn;
    const realizedMultiple = cost > 0 ? realizedReturn / cost : 0;
    const netReturn = realizedReturn - cost;
    const netPctReturn = cost > 0 ? netReturn / cost : 0;

    await db
      .insert(teamResultsTable)
      .values({
        teamId,
        seasonId: s2025.id,
        wins: r.wins.toString(),
        ptDiff: r.ptDiff,
        startingPoints: r.startingPoints.toString(),
        draftOrder: r.draftOrder,
        playoffBerth: r.playoffBerth,
        divRound: r.divRound,
        confRound: r.confRound,
        sbBerth: r.sbBerth,
        winSuperBowl: r.winSuperBowl,
        realizedReturn: realizedReturn.toFixed(6),
        realizedMultiple: realizedMultiple.toFixed(7),
        netReturn: netReturn.toFixed(6),
        netPctReturn: netPctReturn.toFixed(7),
        markToMarket: r.markToMarket.toFixed(6),
      })
      .onConflictDoUpdate({
        target: [teamResultsTable.teamId, teamResultsTable.seasonId],
        set: {
          wins: r.wins.toString(),
          ptDiff: r.ptDiff,
          startingPoints: r.startingPoints.toString(),
          draftOrder: r.draftOrder,
          playoffBerth: r.playoffBerth,
          divRound: r.divRound,
          confRound: r.confRound,
          sbBerth: r.sbBerth,
          winSuperBowl: r.winSuperBowl,
          realizedReturn: realizedReturn.toFixed(6),
          realizedMultiple: realizedMultiple.toFixed(7),
          netReturn: netReturn.toFixed(6),
          netPctReturn: netPctReturn.toFixed(7),
          markToMarket: r.markToMarket.toFixed(6),
        },
      });
    console.log(`  ✓ ${r.teamName}`);
  }

  console.log("Done!");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
