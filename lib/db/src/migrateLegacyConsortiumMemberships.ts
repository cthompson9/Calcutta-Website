import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  biddersTable,
  consortiumMembershipsTable,
  consortiaTable,
} from "./schema";
import { db } from "./index";

const LEGACY_MEMBERSHIP_FROM_DATE = "1900-01-01";
export const CONSORTIUM_MEMBERSHIP_LOCK_NAMESPACE = 841204;
const LEGACY_MIGRATION_LOCK_KEY = 47;

export type LegacyConsortiumMigrationResult = {
  sourceAssignments: number;
  insertedMemberships: number;
  existingMemberships: number;
  consortiums: number;
  validated: true;
};

/**
 * Copies the old bidder-level consortium relation into the dated membership
 * model. It is safe to retry, never overwrites a differing active membership,
 * and intentionally leaves the old column untouched for a later release.
 */
export async function migrateLegacyConsortiumMemberships(): Promise<LegacyConsortiumMigrationResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${CONSORTIUM_MEMBERSHIP_LOCK_NAMESPACE}, ${LEGACY_MIGRATION_LOCK_KEY})`,
    );

    const orphanedLegacyAssignments = await tx
      .select({
        bidderId: biddersTable.id,
        bidderName: biddersTable.name,
      })
      .from(biddersTable)
      .leftJoin(
        consortiaTable,
        eq(biddersTable.legacyConsortiumId, consortiaTable.id),
      )
      .where(
        and(
          isNotNull(biddersTable.legacyConsortiumId),
          isNull(consortiaTable.id),
        ),
      );
    if (orphanedLegacyAssignments.length > 0) {
      throw new Error(
        `Legacy consortium migration found ${orphanedLegacyAssignments.length} bidder assignments without a consortium name.`,
      );
    }

    const legacyAssignments = await tx
      .select({
        bidderId: biddersTable.id,
        bidderName: biddersTable.name,
        consortiumId: biddersTable.legacyConsortiumId,
        consortiumName: consortiaTable.name,
      })
      .from(biddersTable)
      .innerJoin(
        consortiaTable,
        eq(biddersTable.legacyConsortiumId, consortiaTable.id),
      )
      .where(isNotNull(biddersTable.legacyConsortiumId));

    if (legacyAssignments.length === 0) {
      return {
        sourceAssignments: 0,
        insertedMemberships: 0,
        existingMemberships: 0,
        consortiums: 0,
        validated: true,
      };
    }

    const bidderIds = legacyAssignments
      .map((assignment) => assignment.bidderId)
      .sort((left, right) => left - right);
    for (const bidderId of bidderIds) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${CONSORTIUM_MEMBERSHIP_LOCK_NAMESPACE}, ${bidderId})`,
      );
    }

    const memberships = await tx
      .select({
        bidderId: consortiumMembershipsTable.bidderId,
        consortiumId: consortiumMembershipsTable.consortiumId,
        toDate: consortiumMembershipsTable.toDate,
      })
      .from(consortiumMembershipsTable)
      .where(inArray(consortiumMembershipsTable.bidderId, bidderIds));
    const membershipsByBidder = new Map<number, typeof memberships>();
    for (const membership of memberships) {
      const existing = membershipsByBidder.get(membership.bidderId) ?? [];
      existing.push(membership);
      membershipsByBidder.set(membership.bidderId, existing);
    }

    const conflicts = legacyAssignments.filter((assignment) =>
      (membershipsByBidder.get(assignment.bidderId) ?? []).some(
        (membership) =>
          membership.toDate == null &&
          membership.consortiumId !== assignment.consortiumId,
      ),
    );
    if (conflicts.length > 0) {
      throw new Error(
        `Legacy consortium migration found ${conflicts.length} conflicting active memberships. Resolve them before retrying.`,
      );
    }

    let insertedMemberships = 0;
    let existingMemberships = 0;
    for (const assignment of legacyAssignments) {
      if (assignment.consortiumId == null) continue;
      const existing = membershipsByBidder.get(assignment.bidderId) ?? [];
      if (existing.length > 0) {
        existingMemberships += 1;
        continue;
      }
      await tx.insert(consortiumMembershipsTable).values({
        bidderId: assignment.bidderId,
        consortiumId: assignment.consortiumId,
        fromDate: LEGACY_MEMBERSHIP_FROM_DATE,
      });
      membershipsByBidder.set(assignment.bidderId, [
        {
          bidderId: assignment.bidderId,
          consortiumId: assignment.consortiumId,
          toDate: null,
        },
      ]);
      insertedMemberships += 1;
    }

    const verification = await tx
      .select({
        bidderId: biddersTable.id,
        legacyConsortiumId: biddersTable.legacyConsortiumId,
        membershipConsortiumId: consortiumMembershipsTable.consortiumId,
        membershipToDate: consortiumMembershipsTable.toDate,
      })
      .from(biddersTable)
      .leftJoin(
        consortiumMembershipsTable,
        eq(consortiumMembershipsTable.bidderId, biddersTable.id),
      )
      .where(isNotNull(biddersTable.legacyConsortiumId));
    const verificationByBidder = new Map<number, typeof verification>();
    for (const row of verification) {
      const existing = verificationByBidder.get(row.bidderId) ?? [];
      existing.push(row);
      verificationByBidder.set(row.bidderId, existing);
    }
    const mismatches = legacyAssignments.filter((assignment) => {
      const rows = verificationByBidder.get(assignment.bidderId) ?? [];
      if (
        rows.length === 0 ||
        rows.every((row) => row.membershipConsortiumId == null)
      ) {
        return true;
      }
      return rows.some(
        (row) =>
          row.membershipToDate == null &&
          row.membershipConsortiumId !== assignment.consortiumId,
      );
    });
    if (mismatches.length > 0) {
      throw new Error(
        `Legacy consortium migration could not validate ${mismatches.length} bidder assignments.`,
      );
    }

    return {
      sourceAssignments: legacyAssignments.length,
      insertedMemberships,
      existingMemberships,
      consortiums: new Set(
        legacyAssignments.map((assignment) => assignment.consortiumName),
      ).size,
      validated: true,
    };
  });
}