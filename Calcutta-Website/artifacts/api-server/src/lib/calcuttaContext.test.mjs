import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  calcuttasTable,
  db,
  runDatabaseMigrations,
  seasonsTable,
} from "@workspace/db";
import {
  resolveCalcuttaId,
  resolveDefaultSeasonYearForSport,
  resolveSeasonIdForSport,
} from "./calcuttaContext.ts";

test(
  "same-year NFL and CFB contexts resolve independently and reject crossed IDs",
  { skip: !process.env.DATABASE_URL },
  async () => {
    await runDatabaseMigrations();
    const year = 2194;
    const [season] = await db.insert(seasonsTable).values({
      year,
      label: `${year} shared calendar season`,
    }).returning({ id: seasonsTable.id });
    try {
      const [nfl, cfb] = await db.insert(calcuttasTable).values([
        {
          seasonId: season.id,
          year,
          name: `${year} NFL context test`,
          sport: "NFL",
          competitionFormat: "NFL_REGULAR_SEASON",
          isCanonical: true,
        },
        {
          seasonId: season.id,
          year,
          name: `${year} CFB context test`,
          sport: "CFB",
          competitionFormat: "CFB_REGULAR_SEASON",
          isCanonical: true,
        },
      ]).returning({ id: calcuttasTable.id, sport: calcuttasTable.sport });

      assert.equal(
        await resolveSeasonIdForSport(db, { year, sport: "NFL" }),
        season.id,
      );
      assert.equal(
        await resolveSeasonIdForSport(db, { year, sport: "CFB" }),
        season.id,
      );
      assert.equal(
        await resolveCalcuttaId(db, { seasonId: season.id, sport: "NFL" }),
        nfl.id,
      );
      assert.equal(
        await resolveCalcuttaId(db, { seasonId: season.id, sport: "CFB" }),
        cfb.id,
      );
      assert.equal(
        await resolveCalcuttaId(db, {
          seasonId: season.id,
          sport: "NFL",
          calcuttaId: cfb.id,
        }),
        null,
      );

      await assert.rejects(
        db.insert(calcuttasTable).values({
          seasonId: season.id,
          year,
          name: `${year} duplicate NFL canonical context test`,
          sport: "NFL",
          competitionFormat: "NFL_REGULAR_SEASON",
          isCanonical: true,
        }),
        (error) =>
          error?.cause?.constraint === "calcuttas_canonical_season_sport_idx",
      );
    } finally {
      await db.delete(seasonsTable).where(eq(seasonsTable.id, season.id));
    }
  },
);

test(
  "active-season defaults are selected within each sport",
  { skip: !process.env.DATABASE_URL },
  async () => {
    await runDatabaseMigrations();
    const [nflSeason, cfbSeason] = await db.insert(seasonsTable).values([
      { year: 2192, label: "2192 NFL active context test", isActive: true },
      { year: 2193, label: "2193 CFB active context test", isActive: true },
    ]).returning({ id: seasonsTable.id, year: seasonsTable.year });
    try {
      await db.insert(calcuttasTable).values([
        {
          seasonId: nflSeason.id,
          year: nflSeason.year,
          name: "2192 NFL active context test",
          sport: "NFL",
          competitionFormat: "NFL_REGULAR_SEASON",
          isCanonical: true,
        },
        {
          seasonId: cfbSeason.id,
          year: cfbSeason.year,
          name: "2193 CFB active context test",
          sport: "CFB",
          competitionFormat: "CFB_REGULAR_SEASON",
          isCanonical: true,
        },
      ]);
      assert.equal(
        await resolveDefaultSeasonYearForSport(db, {
          sport: "NFL",
          state: "active",
          newestFirst: true,
        }),
        nflSeason.year,
      );
      assert.equal(
        await resolveDefaultSeasonYearForSport(db, {
          sport: "CFB",
          state: "active",
          newestFirst: true,
        }),
        cfbSeason.year,
      );
    } finally {
      await db.delete(seasonsTable).where(eq(seasonsTable.id, nflSeason.id));
      await db.delete(seasonsTable).where(eq(seasonsTable.id, cfbSeason.id));
    }
  },
);