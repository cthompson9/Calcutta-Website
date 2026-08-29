import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  normalizedCalcuttasTable,
  normalizedEntriesTable,
  normalizedEntryTeamsTable,
  normalizedExpectedEntryResultsTable,
  normalizedOwnersTable,
  normalizedPositionsTable,
  normalizedTeamsTable,
  normalizedTradesTable,
} from "@workspace/db";
import {
  GetHistoricalPoolEntriesV2Response,
  GetHistoricalPoolOwnersV2Response,
  GetHistoricalPoolTradesV2Response,
  GetHistoricalPoolsV2Response,
} from "@workspace/api-zod";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";

const router: IRouter = Router();
const historicalPoolId = z.coerce.number().int().positive();
const LAST_HISTORICAL_EDITION = 11;

type HistoricalPool = typeof normalizedCalcuttasTable.$inferSelect;

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadHistoricalPool(id: number): Promise<HistoricalPool | null> {
  const rows = await db
    .select()
    .from(normalizedCalcuttasTable)
    .where(and(
      eq(normalizedCalcuttasTable.id, id),
      lte(normalizedCalcuttasTable.editionNumber, LAST_HISTORICAL_EDITION),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function resolveHistoricalPool(
  rawId: unknown,
  res: Response,
): Promise<HistoricalPool | null> {
  const parsed = historicalPoolId.safeParse(rawId);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: "Historical pool id must be a positive integer." }, 400);
    return null;
  }
  const pool = await loadHistoricalPool(parsed.data);
  if (!pool) {
    sendParsedJson(
      res,
      ErrorResponse,
      { error: "Historical pool not found. This endpoint serves Calcuttas I through XI only." },
      404,
    );
    return null;
  }
  return pool;
}

router.get("/v2/pools", async (_req, res): Promise<void> => {
  const pools = await db
    .select()
    .from(normalizedCalcuttasTable)
    .where(lte(normalizedCalcuttasTable.editionNumber, LAST_HISTORICAL_EDITION))
    .orderBy(desc(normalizedCalcuttasTable.editionNumber));

  sendParsedJson(
    res,
    GetHistoricalPoolsV2Response,
    pools.map((pool) => {
      const potSize = numberOrNull(pool.potSize);
      return {
        id: pool.id,
        edition_number: pool.editionNumber,
        name: pool.name,
        sport: pool.sport,
        format_key: pool.formatKey,
        season_year: pool.seasonYear,
        pot_size: potSize,
        pot_size_available: potSize != null,
        status: pool.status,
      };
    }),
  );
});

router.get("/v2/pool/:id/entries", async (req, res): Promise<void> => {
  const pool = await resolveHistoricalPool(req.params.id, res);
  if (!pool) return;

  const entries = await db
    .select()
    .from(normalizedEntriesTable)
    .where(eq(normalizedEntriesTable.calcuttaId, pool.id))
    .orderBy(asc(normalizedEntriesTable.lotOrder), asc(normalizedEntriesTable.label));
  const entryIds = entries.map((entry) => entry.id);

  const [teamRows, ownerRows, expectedRows, trackingResult] = await Promise.all([
    entryIds.length
      ? db
        .select({
          entryId: normalizedEntryTeamsTable.entryId,
          id: normalizedTeamsTable.id,
          name: normalizedTeamsTable.name,
          seed: normalizedEntryTeamsTable.seed,
          resolved: normalizedEntryTeamsTable.resolved,
        })
        .from(normalizedEntryTeamsTable)
        .innerJoin(
          normalizedTeamsTable,
          eq(normalizedEntryTeamsTable.teamId, normalizedTeamsTable.id),
        )
        .where(inArray(normalizedEntryTeamsTable.entryId, entryIds))
        .orderBy(asc(normalizedTeamsTable.name))
      : Promise.resolve([]),
    entryIds.length
      ? db
        .select({
          entryId: normalizedPositionsTable.entryId,
          id: normalizedOwnersTable.id,
          owner: normalizedOwnersTable.displayName,
          share: normalizedPositionsTable.share,
        })
        .from(normalizedPositionsTable)
        .innerJoin(
          normalizedOwnersTable,
          eq(normalizedPositionsTable.ownerId, normalizedOwnersTable.id),
        )
        .where(inArray(normalizedPositionsTable.entryId, entryIds))
        .orderBy(desc(normalizedPositionsTable.share), asc(normalizedOwnersTable.displayName))
      : Promise.resolve([]),
    entryIds.length
      ? db
        .select()
        .from(normalizedExpectedEntryResultsTable)
        .where(inArray(normalizedExpectedEntryResultsTable.entryId, entryIds))
      : Promise.resolve([]),
    entryIds.length
      ? db.execute(sql`
          select entry_id,
                 string_agg(phrase, ' · ' order by seq nulls last, phrase) as tracking
            from v_tracking
           where entry_id in (${sql.join(entryIds.map((id) => sql`${id}`), sql`, `)})
           group by entry_id
        `)
      : Promise.resolve({ rows: [] }),
  ]);

  const teamsByEntry = new Map<number, Array<{
    id: number;
    name: string;
    seed: number | null;
    resolved: boolean;
  }>>();
  for (const row of teamRows) {
    teamsByEntry.set(row.entryId, [
      ...(teamsByEntry.get(row.entryId) ?? []),
      { id: row.id, name: row.name, seed: row.seed, resolved: row.resolved },
    ]);
  }

  const ownersByEntry = new Map<number, Array<{
    id: number;
    owner: string;
    share: number;
  }>>();
  for (const row of ownerRows) {
    ownersByEntry.set(row.entryId, [
      ...(ownersByEntry.get(row.entryId) ?? []),
      { id: row.id, owner: row.owner, share: Number(row.share) },
    ]);
  }

  const expectedByEntry = new Map(expectedRows.map((row) => [row.entryId, row]));
  const trackingByEntry = new Map(
    trackingResult.rows.map((row) => {
      const value = row as { entry_id: number | string; tracking: string | null };
      return [Number(value.entry_id), value.tracking] as const;
    }),
  );

  sendParsedJson(
    res,
    GetHistoricalPoolEntriesV2Response,
    entries.map((entry) => {
      const expected = expectedByEntry.get(entry.id);
      const price = numberOrNull(entry.price);
      const points = numberOrNull(expected?.points);
      const payout = numberOrNull(expected?.realizedReturn);
      return {
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        attributes: entry.attributes,
        price,
        price_available: price != null,
        teams: teamsByEntry.get(entry.id) ?? [],
        ownership: ownersByEntry.get(entry.id) ?? [],
        tracking: trackingByEntry.get(entry.id) ?? null,
        points,
        points_available: points != null,
        payout,
        payout_available: payout != null,
      };
    }),
  );
});

router.get("/v2/pool/:id/owners", async (req, res): Promise<void> => {
  const pool = await resolveHistoricalPool(req.params.id, res);
  if (!pool) return;

  const result = await db.execute(sql`
    select o.id,
           o.display_name as owner,
           round(sum(p.share), 4)::float8 as lots,
           round(sum(p.share * e.price), 2)::float8 as cost,
           case
             when count(x.realized_return) = count(*) then
               round(sum(p.share * x.realized_return), 2)::float8
             else null
           end as payout
      from normalized_positions p
      join normalized_entries e on e.id = p.entry_id
      join normalized_owners o on o.id = p.owner_id
      left join normalized_expected_entry_results x on x.entry_id = e.id
     where e.calcutta_id = ${pool.id}
       and p.source = 'primary'
     group by o.id, o.display_name
     order by payout desc nulls last, o.display_name
  `);

  sendParsedJson(
    res,
    GetHistoricalPoolOwnersV2Response,
    result.rows.map((raw) => {
      const row = raw as {
        id: number | string;
        owner: string;
        lots: number | string;
        cost: number | string | null;
        payout: number | string | null;
      };
      const cost = numberOrNull(row.cost);
      const payout = numberOrNull(row.payout);
      return {
        id: Number(row.id),
        owner: row.owner,
        lots: Number(row.lots),
        cost,
        cost_available: cost != null,
        payout,
        payout_available: payout != null,
      };
    }),
  );
});

router.get("/v2/pool/:id/trades", async (req, res): Promise<void> => {
  const pool = await resolveHistoricalPool(req.params.id, res);
  if (!pool) return;

  const fromOwner = normalizedOwnersTable;
  const rows = await db
    .select({
      id: normalizedTradesTable.id,
      sheetRef: normalizedTradesTable.sheetRef,
      tradeDate: normalizedTradesTable.tradeDate,
      detail: normalizedTradesTable.detail,
      scope: normalizedTradesTable.scope,
      entry: normalizedEntriesTable.label,
      fromOwnerId: normalizedTradesTable.fromOwnerId,
      toOwnerId: normalizedTradesTable.toOwnerId,
      referenceOwnerId: normalizedTradesTable.referenceOwnerId,
      share: normalizedTradesTable.pct,
      cash: normalizedTradesTable.cash,
      factor: normalizedTradesTable.factor,
      basis: normalizedTradesTable.basis,
      status: normalizedTradesTable.status,
    })
    .from(normalizedTradesTable)
    .leftJoin(
      normalizedEntriesTable,
      eq(normalizedTradesTable.entryId, normalizedEntriesTable.id),
    )
    .where(eq(normalizedTradesTable.calcuttaId, pool.id))
    .orderBy(asc(normalizedTradesTable.tradeDate), asc(normalizedTradesTable.id));

  const ownerIds = [...new Set(rows.flatMap((row) => [
    row.fromOwnerId,
    row.toOwnerId,
    row.referenceOwnerId,
  ]).filter((id): id is number => id != null))];
  const owners = ownerIds.length
    ? await db
      .select({ id: fromOwner.id, name: fromOwner.displayName })
      .from(fromOwner)
      .where(inArray(fromOwner.id, ownerIds))
    : [];
  const ownerName = new Map(owners.map((owner) => [owner.id, owner.name]));

  sendParsedJson(
    res,
    GetHistoricalPoolTradesV2Response,
    rows.map((row) => {
      const cash = numberOrNull(row.cash);
      return {
        id: row.id,
        sheet_ref: row.sheetRef,
        trade_date: row.tradeDate,
        detail: row.detail,
        scope: row.scope,
        entry: row.entry,
        from_owner: row.fromOwnerId == null ? null : ownerName.get(row.fromOwnerId) ?? null,
        to_owner: row.toOwnerId == null ? null : ownerName.get(row.toOwnerId) ?? null,
        reference_owner:
          row.referenceOwnerId == null
            ? null
            : ownerName.get(row.referenceOwnerId) ?? null,
        share: numberOrNull(row.share),
        cash,
        cash_available: cash != null,
        factor: numberOrNull(row.factor),
        basis: row.basis,
        status: row.status,
      };
    }),
  );
});

export default router;