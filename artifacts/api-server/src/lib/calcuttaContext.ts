import { and, eq } from "drizzle-orm";
import {
  calcuttaEntriesTable,
  calcuttasTable,
} from "@workspace/db";

/**
 * Resolves request context to a ledger.  Omitting calcuttaId deliberately keeps
 * old season/year clients working by selecting that season's canonical NFL pool.
 */
export async function resolveCalcuttaId(
  query: Pick<typeof import("@workspace/db").db, "select">,
  args: { seasonId: number; calcuttaId?: number | null },
): Promise<number | null> {
  const rows = await query
    .select({ id: calcuttasTable.id })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, args.seasonId),
        eq(calcuttasTable.sport, "NFL"),
        args.calcuttaId == null
          ? eq(calcuttasTable.isCanonical, true)
          : eq(calcuttasTable.id, args.calcuttaId),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
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