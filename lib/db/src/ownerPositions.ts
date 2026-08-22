import { and, eq, inArray, sql } from "drizzle-orm";
import {
  biddersTable,
  calcuttaEntriesTable,
  calcuttasTable,
  consortiumMembershipsTable,
  positionsTable,
  seasonsTable,
  teamBiddersTable,
  teamSeasonAuctionsTable,
  tradesTable,
} from "./schema";
import { db } from "./index";

type PositionWriter = Pick<typeof db, "select" | "insert" | "delete" | "execute">;
function calcuttaAsOfDate(year: number): string | undefined {
  return year >= 1 && year <= 9999 ? `${year}-08-01` : undefined;
}

async function getOrCreateCanonicalCalcutta(
  writer: PositionWriter,
  seasonId: number,
  year: number,
): Promise<number> {
  const existing = await writer
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.sport, "NFL"),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  await writer
    .insert(calcuttasTable)
    .values({
      seasonId,
      year,
      sport: "NFL",
      name: `${year} NFL Calcutta`,
      isCanonical: true,
      asOfDate: calcuttaAsOfDate(year),
    })
    .onConflictDoNothing({ target: calcuttasTable.name });
  const created = await writer
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(eq(calcuttasTable.name, `${year} NFL Calcutta`))
    .limit(1);
  if (!created[0]) throw new Error("Unable to create canonical Calcutta position ledger.");
  return created[0].id;
}

async function getOrCreateEntry(
  writer: PositionWriter,
  calcuttaId: number,
  teamId: number,
): Promise<number> {
  await writer
    .insert(calcuttaEntriesTable)
    .values({ calcuttaId, teamId })
    .onConflictDoNothing({
      target: [calcuttaEntriesTable.calcuttaId, calcuttaEntriesTable.teamId],
    });
  const entry = await writer
    .select({ id: calcuttaEntriesTable.id })
    .from(calcuttaEntriesTable)
    .where(
      and(
        eq(calcuttaEntriesTable.calcuttaId, calcuttaId),
        eq(calcuttaEntriesTable.teamId, teamId),
      ),
    )
    .limit(1);
  if (!entry[0]) throw new Error("Unable to create Calcutta position entry.");
  return entry[0].id;
}

/**
 * Rebuild the normalized, auditable position ledger from the immutable auction
 * ownership and approved-trade ledger. Call inside the existing season lock.
 */
export async function syncSeasonPositions(
  writer: PositionWriter,
  seasonId: number,
): Promise<void> {
  // Hold a key-share lock through the rebuild. A concurrent fixture or
  // commissioner deletion must wait instead of removing the season between
  // this read and canonical-Calcutta insertion.
  await writer.execute(
    sql`select id from seasons where id = ${seasonId} for key share`,
  );
  const season = await writer
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, seasonId))
    .limit(1);
  if (!season[0]) throw new Error("Cannot sync positions for an unknown season.");

  const calcuttaId = await getOrCreateCanonicalCalcutta(
    writer,
    seasonId,
    season[0].year,
  );
  const auctions = await writer
    .select({
      teamId: teamSeasonAuctionsTable.teamId,
      bidAmount: teamSeasonAuctionsTable.bidAmount,
    })
    .from(teamSeasonAuctionsTable)
    .where(eq(teamSeasonAuctionsTable.seasonId, seasonId));
  const entryIdByTeam = new Map<number, number>();
  for (const auction of auctions) {
    entryIdByTeam.set(
      auction.teamId,
      await getOrCreateEntry(writer, calcuttaId, auction.teamId),
    );
  }

  const entries = await writer
    .select({ id: calcuttaEntriesTable.id })
    .from(calcuttaEntriesTable)
    .where(eq(calcuttaEntriesTable.calcuttaId, calcuttaId));
  if (entries.length) {
    await writer
      .delete(positionsTable)
      .where(inArray(positionsTable.entryId, entries.map((entry) => entry.id)));
  }

  const auctionCostByTeam = new Map(
    auctions.map((auction) => [auction.teamId, Number(auction.bidAmount)]),
  );
  const primaryRows = await writer
    .select({
      teamId: teamBiddersTable.teamId,
      bidderId: teamBiddersTable.bidderId,
      ownershipShare: teamBiddersTable.ownershipShare,
    })
    .from(teamBiddersTable)
    .where(eq(teamBiddersTable.seasonId, seasonId));
  const effectiveShareByTeam = new Map<number, number>();
  const addEffectiveShare = (teamId: number, share: number) => {
    effectiveShareByTeam.set(
      teamId,
      (effectiveShareByTeam.get(teamId) ?? 0) + share,
    );
  };
  for (const owner of primaryRows) {
    addEffectiveShare(owner.teamId, Number(owner.ownershipShare));
  }
  if (primaryRows.length) {
    await writer.insert(positionsTable).values(
      primaryRows.map((owner) => {
        const share = Number(owner.ownershipShare);
        return {
          entryId: entryIdByTeam.get(owner.teamId)!,
          bidderId: owner.bidderId,
          ownershipShare: share.toFixed(6),
          source: "primary",
          costBasis: ((auctionCostByTeam.get(owner.teamId) ?? 0) * share).toFixed(2),
        };
      }),
    );
  }

  const approvedTrades = await writer
    .select()
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.seasonId, seasonId),
        eq(tradesTable.status, "approved"),
      ),
    );
  if (approvedTrades.length) {
    for (const trade of approvedTrades) {
      const share = Number(trade.percentage) / 100;
      addEffectiveShare(trade.teamId, -share);
      addEffectiveShare(trade.teamId, share);
    }
    await writer.insert(positionsTable).values(
      approvedTrades.flatMap((trade) => {
        const entryId = entryIdByTeam.get(trade.teamId);
        if (!entryId) return [];
        const share = Number(trade.percentage) / 100;
        const price = Number(trade.price);
        return [
          {
            entryId,
            bidderId: trade.fromBidderId,
            ownershipShare: (-share).toFixed(6),
            source: "trade",
            costBasis: (-price).toFixed(2),
            tradeId: trade.id,
          },
          {
            entryId,
            bidderId: trade.toBidderId,
            ownershipShare: share.toFixed(6),
            source: "trade",
            costBasis: price.toFixed(2),
            tradeId: trade.id,
          },
        ];
      }),
    );
  }
  for (const auction of auctions) {
    const total = effectiveShareByTeam.get(auction.teamId);
    // Historical imports can contain an auction price before primary owners
    // were entered. They remain on the legacy read path until completed; do
    // not make the startup rollout fail on a position that cannot be built.
    if (total === undefined) continue;
    if (Math.abs(total - 1) > 0.0000005) {
      throw new Error(
        `Signed positions for team ${auction.teamId} must total exactly 1.000000; received ${total.toFixed(6)}.`,
      );
    }
  }
}

/**
 * Idempotent rollout for installations created before dated memberships and
 * signed positions existed. It runs before the API starts accepting traffic.
 */
export async function ensureOwnerPositionRollout(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(841204, 45)`);
    // Legacy values are only a bootstrap source. Once a bidder has dated
    // history, never manufacture a competing open-ended membership.
    await tx.execute(sql`
      insert into consortium_memberships (bidder_id, consortium_id, from_date)
      select b.id, b.consortium_id, date '1900-01-01'
      from bidders b
      where b.consortium_id is not null
        and not exists (
          select 1
          from consortium_memberships m
          where m.bidder_id = b.id
        )
      on conflict do nothing
    `);
    await tx.execute(sql`
      update calcuttas
      set as_of_date = make_date(year, 8, 1)
      where as_of_date is null
        and year between 1 and 9999
    `);

    const seasons = await tx.select({ id: seasonsTable.id }).from(seasonsTable);
    for (const season of seasons) {
      await syncSeasonPositions(tx, season.id);
    }
  });
}