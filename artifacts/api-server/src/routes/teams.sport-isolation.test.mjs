import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  biddersTable,
  calcuttaEntriesTable,
  calcuttasTable,
  db,
  positionsTable,
  runDatabaseMigrations,
  seasonsTable,
  teamsTable,
} from "@workspace/db";
import app from "../app.ts";

async function listen() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

test(
  "concurrent NFL and CFB team reads and writes stay in their selected Calcuttas",
  { skip: !process.env.DATABASE_URL },
  async () => {
    await runDatabaseMigrations();
    const savedAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = "team-sport-isolation-test";
    const year = 2195;
    const [season] = await db.insert(seasonsTable).values({
      year,
      label: `${year} team sport isolation`,
    }).returning({ id: seasonsTable.id });
    const [nflBidder, cfbBidder, replacementBidder] = await db
      .insert(biddersTable)
      .values([
        { name: `${year} NFL owner` },
        { name: `${year} CFB owner` },
        { name: `${year} replacement owner` },
      ])
      .returning({ id: biddersTable.id });
    const [nflTeam, cfbTeam] = await db
      .insert(teamsTable)
      .values([
        { name: `${year} NFL team`, conference: "AFC", division: "East" },
        { name: `${year} CFB team`, conference: "NFC", division: "West" },
      ])
      .returning({ id: teamsTable.id });
    const [nflCalcutta, cfbCalcutta] = await db
      .insert(calcuttasTable)
      .values([
        {
          seasonId: season.id,
          year,
          name: `${year} NFL team isolation`,
          sport: "NFL",
          competitionFormat: "NFL_REGULAR_SEASON",
          isCanonical: true,
        },
        {
          seasonId: season.id,
          year,
          name: `${year} CFB team isolation`,
          sport: "CFB",
          competitionFormat: "CFB_REGULAR_SEASON",
          isCanonical: true,
        },
      ])
      .returning({ id: calcuttasTable.id });
    const [nflEntry, cfbEntry] = await db
      .insert(calcuttaEntriesTable)
      .values([
        { calcuttaId: nflCalcutta.id, teamId: nflTeam.id },
        { calcuttaId: cfbCalcutta.id, teamId: cfbTeam.id },
      ])
      .returning({ id: calcuttaEntriesTable.id });
    await db.insert(positionsTable).values([
      {
        entryId: nflEntry.id,
        bidderId: nflBidder.id,
        ownershipShare: "1",
        source: "primary",
        costBasis: "100",
      },
      {
        entryId: cfbEntry.id,
        bidderId: cfbBidder.id,
        ownershipShare: "1",
        source: "primary",
        costBasis: "80",
      },
    ]);

    const { server, baseUrl } = await listen();
    try {
      const [legacyResponse, nflResponse, cfbResponse] = await Promise.all([
        fetch(`${baseUrl}/api/teams?season=${year}`),
        fetch(`${baseUrl}/api/teams?season=${year}&sport=NFL`),
        fetch(`${baseUrl}/api/teams?season=${year}&sport=CFB`),
      ]);
      assert.equal(legacyResponse.status, 200);
      assert.equal(nflResponse.status, 200);
      assert.equal(cfbResponse.status, 200);
      assert.deepEqual(
        (await legacyResponse.json()).map((team) => team.id),
        [nflTeam.id],
      );
      assert.deepEqual(
        (await nflResponse.json()).map((team) => team.id),
        [nflTeam.id],
      );
      assert.deepEqual(
        (await cfbResponse.json()).map((team) => team.id),
        [cfbTeam.id],
      );

      const update = (teamId, sport, calcuttaId, bidAmount) =>
        fetch(`${baseUrl}/api/teams/${teamId}`, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer team-sport-isolation-test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            season: year,
            sport,
            calcuttaId,
            bidAmount,
            owners: [{ bidderId: replacementBidder.id, ownershipShare: 1 }],
          }),
        });
      const [nflUpdate, cfbUpdate] = await Promise.all([
        update(nflTeam.id, "NFL", nflCalcutta.id, 110),
        update(cfbTeam.id, "CFB", cfbCalcutta.id, 90),
      ]);
      assert.equal(nflUpdate.status, 200, await nflUpdate.text());
      assert.equal(cfbUpdate.status, 200, await cfbUpdate.text());

      const crossed = await update(cfbTeam.id, "NFL", cfbCalcutta.id, 999);
      assert.equal(crossed.status, 400);

      const rows = await db
        .select({
          entryId: positionsTable.entryId,
          bidderId: positionsTable.bidderId,
          costBasis: positionsTable.costBasis,
        })
        .from(positionsTable)
        .where(and(
          eq(positionsTable.source, "primary"),
          eq(positionsTable.bidderId, replacementBidder.id),
        ));
      assert.deepEqual(
        rows
          .filter((row) => row.entryId === nflEntry.id)
          .map((row) => Number(row.costBasis)),
        [110],
      );
      assert.deepEqual(
        rows
          .filter((row) => row.entryId === cfbEntry.id)
          .map((row) => Number(row.costBasis)),
        [90],
      );
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.delete(seasonsTable).where(eq(seasonsTable.id, season.id));
      await db.delete(teamsTable).where(eq(teamsTable.id, nflTeam.id));
      await db.delete(teamsTable).where(eq(teamsTable.id, cfbTeam.id));
      await db.delete(biddersTable).where(eq(biddersTable.id, nflBidder.id));
      await db.delete(biddersTable).where(eq(biddersTable.id, cfbBidder.id));
      await db.delete(biddersTable).where(eq(biddersTable.id, replacementBidder.id));
      if (savedAdminKey === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = savedAdminKey;
    }
  },
);