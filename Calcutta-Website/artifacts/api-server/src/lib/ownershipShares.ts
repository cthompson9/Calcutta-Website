export const OWNERSHIP_SHARE_EPSILON = 0.00005;
/** Shared PostgreSQL advisory-lock namespace for ownership writes per season. */
export const OWNERSHIP_SEASON_LOCK_NAMESPACE = 47_291;

export type OwnershipShareInput = {
  bidderId: number;
  share: number;
};

export type OwnershipShareValidation =
  | { ok: true; owners: OwnershipShareInput[] }
  | { ok: false; error: string };

/**
 * Validates a complete primary ownership split. Callers must resolve names to
 * bidder IDs before invoking this helper so ownership is never inferred.
 */
export function validatePrimaryOwnership(
  input: OwnershipShareInput[],
): OwnershipShareValidation {
  if (input.length === 0) {
    return { ok: false, error: "At least one owner is required." };
  }

  const bidderIds = new Set<number>();
  let totalBasisPoints = 0;
  for (const owner of input) {
    if (!Number.isInteger(owner.bidderId) || owner.bidderId <= 0) {
      return { ok: false, error: "Every owner must resolve to a valid bidder." };
    }
    if (bidderIds.has(owner.bidderId)) {
      return { ok: false, error: "Each bidder may appear only once in an ownership split." };
    }
    if (!Number.isFinite(owner.share) || owner.share <= 0 || owner.share > 1) {
      return { ok: false, error: "Each ownership share must be greater than 0 and no more than 1." };
    }
    const basisPoints = Math.round(owner.share * 10_000);
    if (Math.abs(owner.share * 10_000 - basisPoints) > 0.000001) {
      return {
        ok: false,
        error: "Each ownership share can have at most four decimal places.",
      };
    }
    bidderIds.add(owner.bidderId);
    totalBasisPoints += basisPoints;
  }

  if (totalBasisPoints !== 10_000) {
    return {
      ok: false,
      error: `Ownership shares must add up to 1.0000 after four-decimal storage (received ${(totalBasisPoints / 10_000).toFixed(4)}).`,
    };
  }

  return {
    ok: true,
    owners: input.map((owner) => ({
      bidderId: owner.bidderId,
      share: Math.round(owner.share * 10_000) / 10_000,
    })),
  };
}