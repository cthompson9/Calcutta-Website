import { and, asc, desc, eq } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  calcuttasTable,
  seasonsTable,
} from "@workspace/db";

export const DEFAULT_CALCUTTA_SPORT = "NFL";

type CalcuttaQuery = Pick<typeof import("@workspace/db").db, "select">;

/**
 * Resolves request context to a ledger.  Omitting calcuttaId deliberately keeps
 * old season/year clients working by selecting that season's canonical NFL pool.
 */
export async function resolveCalcuttaId(
  query: CalcuttaQuery,
  args: { seasonId: number; sport?: string; calcuttaId?: number | null },
): Promise<number | null> {
  const sport = args.sport ?? DEFAULT_CALCUTTA_SPORT;
  const rows = await query
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, args.seasonId),
        eq(calcuttasTable.sport, sport),
        args.calcuttaId == null
          ? eq(calcuttasTable.isCanonical, true)
          : eq(calcuttasTable.id, args.calcuttaId),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new Error(`Multiple canonical ${sport} Calcuttas are configured for season ${args.seasonId}.`);
  }
  return rows[0]?.id ?? null;
}

export async function resolveSeasonIdForSport(
  query: CalcuttaQuery,
  args: { year: number; sport?: string },
): Promise<number | null> {
  const sport = args.sport ?? DEFAULT_CALCUTTA_SPORT;
  const rows = await query
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .innerJoin(
      calcuttasTable,
      and(
        eq(calcuttasTable.seasonId, seasonsTable.id),
        eq(calcuttasTable.sport, sport),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .where(eq(seasonsTable.year, args.year))
    .limit(2);
  if (rows.length > 1) {
    throw new Error(`Multiple canonical ${sport} Calcuttas are configured for ${args.year}.`);
  }
  return rows[0]?.id ?? null;
}

export async function resolveDefaultSeasonYearForSport(
  query: CalcuttaQuery,
  args: {
    sport?: string;
    state: "active" | "complete";
    newestFirst?: boolean;
  },
): Promise<number | null> {
  const sport = args.sport ?? DEFAULT_CALCUTTA_SPORT;
  const stateCondition = args.state === "active"
    ? eq(seasonsTable.isActive, true)
    : eq(seasonsTable.isComplete, true);
  const rows = await query
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .innerJoin(
      calcuttasTable,
      and(
        eq(calcuttasTable.seasonId, seasonsTable.id),
        eq(calcuttasTable.sport, sport),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .where(stateCondition)
    .orderBy(args.newestFirst ? desc(seasonsTable.year) : asc(seasonsTable.year))
    .limit(1);
  return rows[0]?.year ?? null;
}

export async function getOrCreateCalcuttaEntry(
  writer: Pick<typeof import("@workspace/db").db, "select" | "insert">,
  calcuttaId: number,
  teamId: number,
): Promise<number> {
  await writer.insert(calcuttaEntriesTable).values({ calcuttaId, teamId })
    .onConflictDoNothing({ target: [calcuttaEntriesTable.calcuttaId, calcuttaEntriesTable.teamId] });
  const rows = await writer.select({ id: calcuttaEntriesTable.id })
    .from(calcuttaEntriesTable)
    .where(and(eq(calcuttaEntriesTable.calcuttaId, calcuttaId), eq(calcuttaEntriesTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) throw new Error("Unable to resolve Calcutta entry.");
  return rows[0].id;
}