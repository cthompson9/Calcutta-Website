export type MtmMoneyRow = {
  entryId: number;
  value: number;
};

/**
 * Round a complete team-value set to cents while preserving the pool exactly.
 * Residual cents go to the rows whose nearest-cent rounding error best offsets
 * the residual; ties are resolved by entry ID so retries are deterministic.
 */
export function allocateMtmPoolCents(
  rows: MtmMoneyRow[],
  poolValue: number,
): Map<number, number> {
  if (!Number.isFinite(poolValue) || poolValue < 0) {
    throw new Error("MTM pool value must be finite and nonnegative.");
  }
  if (Math.abs(poolValue * 100 - Math.round(poolValue * 100)) > 1e-6) {
    throw new Error("MTM pool value must be representable in whole cents.");
  }
  if (new Set(rows.map((row) => row.entryId)).size !== rows.length) {
    throw new Error("MTM cent allocation requires unique entry IDs.");
  }
  if (rows.some((row) => !Number.isFinite(row.value) || row.value < 0)) {
    throw new Error("MTM team values must be finite and nonnegative.");
  }
  const rawTotal = rows.reduce((sum, row) => sum + row.value, 0);
  const maximumRoundingDiscrepancy = rows.length * 0.005 + 1e-6;
  if (Math.abs(rawTotal - poolValue) > maximumRoundingDiscrepancy) {
    throw new Error(
      `MTM team values differ from the pool by more than the maximum cent-rounding residual.`,
    );
  }

  const allocations = rows.map((row) => {
    const rawCents = row.value * 100;
    const cents = Math.round(rawCents);
    return { ...row, rawCents, cents, roundingError: rawCents - cents };
  });
  const poolCents = Math.round(poolValue * 100);
  let residual = poolCents - allocations.reduce((sum, row) => sum + row.cents, 0);
  const direction = Math.sign(residual);
  const candidates = [...allocations].sort((left, right) => {
    const errorDifference = direction >= 0
      ? right.roundingError - left.roundingError
      : left.roundingError - right.roundingError;
    return errorDifference || left.entryId - right.entryId;
  });

  if (candidates.length === 0 && residual !== 0) {
    throw new Error("MTM cent allocation cannot reconcile an empty value set.");
  }
  let index = 0;
  while (residual !== 0) {
    const candidate = candidates[index % candidates.length]!;
    if (direction > 0 || candidate.cents > 0) {
      candidate.cents += direction;
      residual -= direction;
    }
    index += 1;
    if (index > Math.max(1000, Math.abs(poolCents) + candidates.length)) {
      throw new Error("MTM cent allocation could not reconcile to the pool.");
    }
  }

  return new Map(allocations.map((row) => [row.entryId, row.cents / 100]));
}