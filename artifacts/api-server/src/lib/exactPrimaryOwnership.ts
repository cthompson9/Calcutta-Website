import { and, desc, eq } from "drizzle-orm";
import { db, ownershipAdjustmentsTable, positionsTable, calcuttaEntriesTable, calcuttasTable } from "@workspace/db";
import { fraction, sumFractions, type ExactFraction } from "./exactOwnershipFractions";

export const EXACT_FRACTION_SOURCE = "exact_fraction_ownership";
type PositionInput = { entryId: number; bidderId: number; source: string; ownershipShare: string; costBasis: string };
type SavedOwner = { bidderId: number; storedShare: string; costCents: number; numerator: string; denominator: string };
type FractionSnapshot = { kind: "exact_fraction_split"; calcuttaId: number; entryId: number; owners: SavedOwner[] };

export function validateFractionSnapshot(value: unknown): FractionSnapshot {
  const snapshot = value as FractionSnapshot;
  if (snapshot?.kind !== "exact_fraction_split" || snapshot.calcuttaId !== 2061 ||
      !Number.isSafeInteger(snapshot.entryId) || !Array.isArray(snapshot.owners) || !snapshot.owners.length ||
      snapshot.owners.some(owner => !Number.isSafeInteger(owner.bidderId) ||
        typeof owner.numerator !== "string" || !/^\d{1,18}$/.test(owner.numerator) ||
        typeof owner.denominator !== "string" || !/^[1-9]\d{0,17}$/.test(owner.denominator) ||
        !(Number(owner.storedShare) > 0) || !Number.isSafeInteger(owner.costCents) || owner.costCents <= 0) ||
      new Set(snapshot.owners.map(owner => owner.bidderId)).size !== snapshot.owners.length) {
    throw new Error("Invalid audited exact-fraction ownership.");
  }
  const fractions = snapshot.owners.map(owner => fraction(BigInt(owner.numerator), BigInt(owner.denominator)));
  const sum = sumFractions(fractions);
  if (fractions.some(share => share.numerator <= 0n) || sum.numerator !== sum.denominator) {
    throw new Error("Audited exact owner fractions do not total 100%.");
  }
  return snapshot;
}

export async function loadExactPrimaryFractions(
  database: Pick<typeof db, "select">, calcuttaId: number | undefined, rows: PositionInput[],
): Promise<Map<string, ExactFraction>> {
  const resolved = new Map<string, ExactFraction>();
  if (calcuttaId !== 2061) return resolved;
  const adjustments = await database.select().from(ownershipAdjustmentsTable)
    .where(eq(ownershipAdjustmentsTable.source, EXACT_FRACTION_SOURCE)).orderBy(desc(ownershipAdjustmentsTable.id));
  const snapshots = new Map<number, FractionSnapshot>();
  for (const adjustment of adjustments) {
    const saved = validateFractionSnapshot(adjustment.owners);
    if (!snapshots.has(saved.entryId)) snapshots.set(saved.entryId, saved);
  }
  for (const row of rows.filter(row => row.source === "primary")) {
    const saved = snapshots.get(row.entryId);
    if (!saved) continue;
    const owner = saved.owners.find(owner => owner.bidderId === row.bidderId);
    if (!owner || Number(owner.storedShare) !== Number(row.ownershipShare) ||
        owner.costCents !== Math.round(Number(row.costBasis) * 100)) {
      throw new Error("Primary ledger differs from its audited exact-fraction split; commissioner review is required.");
    }
    resolved.set(`${row.entryId}:${row.bidderId}`, fraction(BigInt(owner.numerator), BigInt(owner.denominator)));
  }
  return resolved;
}

/** Append exact intent beside the conserved finite-decimal compatibility ledger. */
export async function recordExactPrimaryFractions(
  tx: any, calcuttaId: number, entryId: number,
  owners: Array<{ bidderId: number; numerator: string; denominator: string }>, note: string,
): Promise<void> {
  if (calcuttaId !== 2061) return;
  const [entry] = await tx.select({ teamId: calcuttaEntriesTable.teamId, seasonId: calcuttasTable.seasonId })
    .from(calcuttaEntriesTable).innerJoin(calcuttasTable, eq(calcuttasTable.id, calcuttaEntriesTable.calcuttaId))
    .where(and(eq(calcuttaEntriesTable.id, entryId), eq(calcuttaEntriesTable.calcuttaId, calcuttaId)));
  if (!entry) throw new Error("Exact ownership entry is outside Calcutta XIII.");
  const primary: any[] = await tx.select().from(positionsTable)
    .where(and(eq(positionsTable.entryId, entryId), eq(positionsTable.source, "primary")));
  if (primary.length !== owners.length) throw new Error("Exact ownership does not cover every primary owner.");
  const snapshot = validateFractionSnapshot({
    kind: "exact_fraction_split", calcuttaId, entryId,
    owners: owners.map(owner => {
      const position = primary.find(row => row.bidderId === owner.bidderId);
      if (!position) throw new Error("Exact owner is missing its primary position.");
      return { ...owner, storedShare: position.ownershipShare, costCents: Math.round(Number(position.costBasis) * 100) };
    }),
  });
  await tx.insert(ownershipAdjustmentsTable).values({
    seasonId: entry.seasonId, teamId: entry.teamId, source: EXACT_FRACTION_SOURCE, note, owners: snapshot,
  });
}
