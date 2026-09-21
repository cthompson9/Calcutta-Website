import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  calcuttasTable,
  db,
  mtmEntryValuationTable,
  mtmMarketQuoteTable,
  mtmSnapshotTable,
  mtmTeamProjectionTable,
  mtmValuationVersionTable,
  seasonsTable,
} from "@workspace/db";

export type ReferenceMarketReadInput = {
  season: number;
  calcuttaId?: number;
  snapshotId?: number;
  team?: string;
  family?: "wins" | "elimination";
  ticker?: string;
  limit?: number;
  cursor?: string;
};

export class ReferenceMarketReadError extends Error {
  constructor(public readonly status: 400 | 404, message: string) {
    super(message);
  }
}

type Cursor = {
  snapshotId: number;
  filters: Omit<ReferenceMarketReadInput, "cursor" | "limit">;
  last: string;
};

export type MtmReferenceMarketRepository = {
  findSeasonId(season: number): Promise<number | null>;
  findPoolId(seasonId: number, calcuttaId?: number): Promise<number | null>;
  findCurrent(poolId: number): Promise<Array<{ version: any; snapshot: any }>>;
  findOfficialSnapshot(poolId: number, snapshotId: number): Promise<{ version: any; snapshot: any } | null>;
  listQuotes(snapshotId: number): Promise<any[]>;
  listProjections(snapshotId: number, teams: string[]): Promise<any[]>;
  listValuations(snapshotId: number, entryIds: number[]): Promise<any[]>;
};

const TEAM_CODES = new Set([
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
  "DET", "GB", "HOU", "IND", "JAC", "KC", "LV", "LAC", "LAR", "MIA",
  "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SF", "SEA", "TB", "TEN", "WAS",
]);

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

export function sanitizeReferenceMarketUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function cursorEncode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function cursorDecode(value: string): Cursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (!decoded || !Number.isInteger(decoded.snapshotId) || typeof decoded.last !== "string") throw new Error();
    return decoded;
  } catch {
    throw new ReferenceMarketReadError(400, "Invalid cursor.");
  }
}

function normalizeInput(input: ReferenceMarketReadInput): Required<Omit<ReferenceMarketReadInput, "cursor">> & { cursor?: string } {
  if (!Number.isInteger(input.season)) throw new ReferenceMarketReadError(400, "season must be an integer.");
  if (input.calcuttaId != null && (!Number.isInteger(input.calcuttaId) || input.calcuttaId <= 0)) {
    throw new ReferenceMarketReadError(400, "calcuttaId must be a positive integer.");
  }
  if (input.snapshotId != null && (!Number.isInteger(input.snapshotId) || input.snapshotId <= 0)) {
    throw new ReferenceMarketReadError(400, "snapshotId must be a positive integer.");
  }
  if (input.team != null) {
    const team = input.team.trim().toUpperCase();
    if (!TEAM_CODES.has(team)) throw new ReferenceMarketReadError(400, "team must be a canonical NFL team code.");
    input = { ...input, team };
  }
  if (input.family != null && input.family !== "wins" && input.family !== "elimination") {
    throw new ReferenceMarketReadError(400, "family must be wins or elimination.");
  }
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ReferenceMarketReadError(400, "limit must be an integer from 1 to 200.");
  return { ...input, limit } as Required<Omit<ReferenceMarketReadInput, "cursor">> & { cursor?: string };
}

function familyForQuote(series: string, family: string | null): "wins" | "elimination" {
  if (family === "wins" || family === "elimination") return family;
  return /WIN|TOTAL/i.test(series) ? "wins" : "elimination";
}

const databaseRepository: MtmReferenceMarketRepository = {
  async findSeasonId(season) {
    const rows = await db.select({ id: seasonsTable.id }).from(seasonsTable)
      .where(eq(seasonsTable.year, season)).limit(1);
    return rows[0]?.id ?? null;
  },
  async findPoolId(seasonId, calcuttaId) {
    const rows = await db.select({ id: calcuttasTable.id }).from(calcuttasTable)
      .where(and(
        eq(calcuttasTable.seasonId, seasonId), eq(calcuttasTable.sport, "NFL"),
        calcuttaId ? eq(calcuttasTable.id, calcuttaId) : eq(calcuttasTable.isCanonical, true),
      )).limit(2);
    return rows.length === 1 ? rows[0]!.id : null;
  },
  async findCurrent(poolId) {
    return db.select({
      version: mtmValuationVersionTable, snapshot: mtmSnapshotTable,
    }).from(mtmValuationVersionTable)
      .innerJoin(mtmSnapshotTable, eq(mtmSnapshotTable.id, mtmValuationVersionTable.sourceSnapshotId))
      .where(and(
        eq(mtmValuationVersionTable.poolId, poolId), eq(mtmValuationVersionTable.status, "current"),
        eq(mtmSnapshotTable.status, "ok"),
      )).orderBy(desc(mtmValuationVersionTable.createdAt)).limit(2);
  },
  async findOfficialSnapshot(poolId, snapshotId) {
    const rows = await db.select({
      version: mtmValuationVersionTable, snapshot: mtmSnapshotTable,
    }).from(mtmValuationVersionTable)
      .innerJoin(mtmSnapshotTable, eq(mtmSnapshotTable.id, mtmValuationVersionTable.sourceSnapshotId))
      .where(and(
        eq(mtmValuationVersionTable.poolId, poolId), eq(mtmValuationVersionTable.sourceSnapshotId, snapshotId),
        eq(mtmValuationVersionTable.markType, "official"), eq(mtmSnapshotTable.status, "ok"),
      )).limit(1);
    return rows[0] ?? null;
  },
  listQuotes: async (snapshotId) => db.select().from(mtmMarketQuoteTable)
    .where(eq(mtmMarketQuoteTable.snapshotId, snapshotId)).orderBy(asc(mtmMarketQuoteTable.marketTicker)),
  listProjections: async (snapshotId, teams) => teams.length === 0 ? [] : db.select().from(mtmTeamProjectionTable)
    .where(and(eq(mtmTeamProjectionTable.snapshotId, snapshotId), inArray(mtmTeamProjectionTable.team, teams))),
  listValuations: async (snapshotId, entryIds) => entryIds.length === 0 ? [] : db.select({
    entryId: mtmEntryValuationTable.entryId, expectedPayout: mtmEntryValuationTable.expectedPayout,
  }).from(mtmEntryValuationTable).where(and(
    eq(mtmEntryValuationTable.snapshotId, snapshotId), inArray(mtmEntryValuationTable.entryId, entryIds),
  )),
};

export async function readMtmReferenceMarkets(
  input: ReferenceMarketReadInput,
  repository: MtmReferenceMarketRepository = databaseRepository,
) {
  const normalized = normalizeInput(input);
  const requestedCursor = normalized.cursor ? cursorDecode(normalized.cursor) : null;
  const seasonId = await repository.findSeasonId(normalized.season);
  if (seasonId == null) throw new ReferenceMarketReadError(404, `Season ${normalized.season} not found.`);
  const calcuttaId = await repository.findPoolId(seasonId, normalized.calcuttaId);
  if (calcuttaId == null) {
    throw new ReferenceMarketReadError(404, "Calcutta is not an NFL pool in the requested season.");
  }
  const currentRows = await repository.findCurrent(calcuttaId);
  const official = currentRows.find((row) => row.version.markType === "official");
  const display = currentRows[0]?.version;
  const snapshotId = normalized.snapshotId ?? requestedCursor?.snapshotId ?? official?.snapshot.id ?? null;
  let source: { version: any; snapshot: any } | null | undefined = official;
  if (snapshotId != null && (!source || source.snapshot.id !== snapshotId)) {
    source = (await repository.findOfficialSnapshot(calcuttaId, snapshotId)) ?? undefined;
    if (!source) throw new ReferenceMarketReadError(404, "Snapshot is not an official snapshot in the requested pool.");
  }
  if (!source) {
    return {
      schemaVersion: "1.0", available: false, season: normalized.season, calcuttaId,
      snapshot: null,
      currentState: {
        markType: display?.markType ?? "unavailable",
        pendingActualsRevision: display?.actualsStateHash ?? null,
        usesArchivedOfficial: false, stale: true, staleReasons: ["no_official_reference_snapshot"],
      },
      units: { quotePrice: "USD_per_1_USD_payout", probability: "0_to_1", valuation: "USD" },
      summary: { totalMarkets: 0, freshCount: 0, carriedForwardCount: 0, settledCount: 0, unavailableCount: 0 },
      markets: [], teamValues: [], pagination: { limit: normalized.limit, returned: 0, nextCursor: null },
    };
  }
  const cursor = requestedCursor;
  const filters = { season: normalized.season, calcuttaId, snapshotId: source.snapshot.id, team: normalized.team, family: normalized.family, ticker: normalized.ticker };
  if (cursor && (cursor.snapshotId !== source.snapshot.id || JSON.stringify(cursor.filters) !== JSON.stringify(filters))) {
    throw new ReferenceMarketReadError(400, "Cursor does not match the selected snapshot and filters.");
  }
  const quotes = await repository.listQuotes(source.snapshot.id);
  const rows = quotes.map((quote) => {
    const family = familyForQuote(quote.series, quote.family);
    const key = `${family}|${quote.team ?? ""}|${quote.marketTicker}`;
    const status = quote.status ?? (quote.outcome ? "settled" : "unknown");
    const acceptedAt = quote.referenceAcceptedAt ?? quote.capturedAt ?? quote.fetchedAt;
    const age = Math.max(0, Math.floor((Date.now() - acceptedAt.getTime()) / 1000));
    return {
      key, ticker: quote.marketTicker, eventTicker: quote.contract ?? null, provider: quote.provider ?? quote.source,
      sourceUrl: sanitizeReferenceMarketUrl(quote.sourceUrl),
      team: quote.team, family, outcome: family === "elimination" ? quote.outcome : null,
      strike: family === "wins" ? numberOrNull(quote.strike) : null, marketStatus: status,
      bid: numberOrNull(quote.yesBid), ask: numberOrNull(quote.yesAsk), last: numberOrNull(quote.lastPrice),
      lastTradeAt: null, quoteCapturedAt: isoOrNull(quote.capturedAt),
      referencePrice: numberOrNull(quote.referencePrice), selectionMethod: quote.selectionMethod,
      reasonCodes: quote.selectionReason ? Object.values(quote.selectionReason).filter((v): v is string => typeof v === "string") : [],
      referenceAcceptedAt: acceptedAt.toISOString(), referenceSourceSnapshotId: quote.referenceSourceSnapshotId,
      referenceSourceTicker: quote.referenceSourceTicker, carriedForward: quote.selectionMethod === "carried_forward",
      referenceAgeSeconds: age, fairProbability: numberOrNull(quote.referencePrice),
      probabilityBasis: quote.referencePrice == null ? "unavailable_reference_mark" : "exact_contract_reference_mark",
    };
  }).filter((row) =>
    (!normalized.team || row.team === normalized.team) &&
    (!normalized.family || row.family === normalized.family) &&
    (!normalized.ticker || row.ticker === normalized.ticker) &&
    (!cursor || row.key > cursor.last),
  );
  const page = rows.slice(0, normalized.limit);
  const nextCursor = rows.length > normalized.limit
    ? cursorEncode({ snapshotId: source.snapshot.id, filters, last: page.at(-1)!.key })
    : null;
  const pageTeams = [...new Set(page.map((row) => row.team).filter((team): team is string => Boolean(team)))];
  const projections = await repository.listProjections(source.snapshot.id, pageTeams);
  const projectionByTeam = new Map(projections.map((row) => [row.team, row]));
  const stateEntries: Array<Record<string, unknown>> = Array.isArray(source.snapshot.stateJson?.entries)
    ? source.snapshot.stateJson.entries.filter(
      (entry: unknown): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"),
    )
    : [];
  const entryIds = stateEntries
    .map((entry) => Number(entry.entry_id))
    .filter((id) => Number.isInteger(id));
  const valuationRows = await repository.listValuations(source.snapshot.id, entryIds);
  const payoutByEntry = new Map(valuationRows.map((row) => [row.entryId, numberOrNull(row.expectedPayout)]));
  const grossByTeam = new Map<string, number | null>();
  for (const entry of stateEntries) {
    const team = typeof entry.team === "string" ? entry.team : null;
    const entryId = Number(entry.entry_id);
    if (team && Number.isInteger(entryId) && payoutByEntry.has(entryId)) grossByTeam.set(team, payoutByEntry.get(entryId) ?? null);
  }
  const teamValues = [...new Set(page.map((row) => row.team).filter((team): team is string => Boolean(team)))].map((team) => {
    const projection = projectionByTeam.get(team);
    const gross = grossByTeam.get(team) ?? null;
    return {
      team, grossTeamValue: gross, valuePerOnePercentOwnership: gross == null ? null : gross / 100,
      fairReachProbabilities: projection ? {
        playoff: numberOrNull(projection.pBerth), divisional: numberOrNull(projection.pDivisional),
        conference: numberOrNull(projection.pConf), superBowl: numberOrNull(projection.pSbBerth), champion: numberOrNull(projection.pSbWin),
      } : null, snapshotId: source.snapshot.id,
    };
  });
  return {
    schemaVersion: "1.0", available: true, season: normalized.season, calcuttaId,
    snapshot: {
      id: source.snapshot.id, valuationVersionId: source.version.id, asOf: source.snapshot.asOf.toISOString(),
      actualsRevision: source.version.actualsStateHash, pricingMethodVersion: source.snapshot.methodVersion,
      referencePolicyVersion: (source.snapshot.diagnostics as any)?.policy_version ?? source.snapshot.methodVersion,
    },
    currentState: {
      markType: display?.markType ?? "official", pendingActualsRevision: display?.markType === "pending_recalculation" ? display.actualsStateHash : null,
      usesArchivedOfficial: display?.sourceSnapshotId !== source.snapshot.id, stale: display?.sourceSnapshotId !== source.snapshot.id,
      staleReasons: display?.sourceSnapshotId !== source.snapshot.id ? ["pending_actuals_recalculation"] : [],
    },
    units: { quotePrice: "USD_per_1_USD_payout", probability: "0_to_1", valuation: "USD" },
    summary: {
      totalMarkets: rows.length, freshCount: rows.filter((row) => !row.carriedForward && row.referencePrice != null).length,
      carriedForwardCount: rows.filter((row) => row.carriedForward).length,
      settledCount: rows.filter((row) => row.marketStatus === "settled").length,
      unavailableCount: rows.filter((row) => row.referencePrice == null).length,
    },
    markets: page.map(({ key: _key, ...row }) => row), teamValues,
    pagination: { limit: normalized.limit, returned: page.length, nextCursor },
  };
}