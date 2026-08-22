import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  biddersTable,
  calcuttasTable,
  consortiumMembershipsTable,
  consortiaTable,
  db,
  seasonsTable,
} from "@workspace/db";

export type MembershipView = "historical" | "current";

async function loadLegacyBidderConsortiums(
  bidderIds?: number[],
): Promise<Map<number, string>> {
  if (bidderIds && bidderIds.length === 0) return new Map();

  const legacyRows = await db
    .select({
      bidderId: biddersTable.id,
      consortium: consortiaTable.name,
    })
    .from(biddersTable)
    .innerJoin(
      consortiaTable,
      eq(consortiaTable.id, biddersTable.legacyConsortiumId),
    )
    .where(
      bidderIds
        ? inArray(biddersTable.id, bidderIds)
        : isNotNull(biddersTable.legacyConsortiumId),
    );
  return new Map(
    legacyRows.map((membership) => [membership.bidderId, membership.consortium]),
  );
}

async function loadBiddersWithMembershipHistory(
  bidderIds?: number[],
): Promise<Set<number>> {
  if (bidderIds && bidderIds.length === 0) return new Set();

  const memberships = await db
    .select({ bidderId: consortiumMembershipsTable.bidderId })
    .from(consortiumMembershipsTable)
    .where(
      bidderIds
        ? inArray(consortiumMembershipsTable.bidderId, bidderIds)
        : undefined,
    );
  return new Set(memberships.map((membership) => membership.bidderId));
}

function preserveLegacyFallback(
  memberships: Map<number, string>,
  legacyMemberships: Map<number, string>,
  biddersWithMembershipHistory: Set<number>,
): Map<number, string> {
  for (const [bidderId, consortium] of legacyMemberships) {
    if (
      !memberships.has(bidderId) &&
      !biddersWithMembershipHistory.has(bidderId)
    ) {
      memberships.set(bidderId, consortium);
    }
  }
  return memberships;
}

/**
 * Loads the current roster for the bidder directory and commissioner tools.
 * Historical reports must use loadSeasonConsortiums instead so a later
 * reassignment cannot rewrite an earlier Calcutta.
 */
export async function loadCurrentBidderConsortiums(
  bidderIds?: number[],
): Promise<Map<number, string>> {
  if (bidderIds && bidderIds.length === 0) return new Map();

  const memberships = await db
    .select({
      bidderId: consortiumMembershipsTable.bidderId,
      consortium: consortiaTable.name,
    })
    .from(consortiumMembershipsTable)
    .innerJoin(
      consortiaTable,
      eq(consortiaTable.id, consortiumMembershipsTable.consortiumId),
    )
    .where(
      bidderIds
        ? and(
            inArray(consortiumMembershipsTable.bidderId, bidderIds),
            isNull(consortiumMembershipsTable.toDate),
          )
        : isNull(consortiumMembershipsTable.toDate),
    );

  const currentMemberships = new Map(
    memberships.map((membership) => [membership.bidderId, membership.consortium]),
  );
  const [legacyMemberships, biddersWithMembershipHistory] = await Promise.all([
    loadLegacyBidderConsortiums(bidderIds),
    loadBiddersWithMembershipHistory(bidderIds),
  ]);
  return preserveLegacyFallback(
    currentMemberships,
    legacyMemberships,
    biddersWithMembershipHistory,
  );
}

function todayIso(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month").padStart(2, "0")}-${value("day").padStart(2, "0")}`;
}

/**
 * Resolves bidder → consortium using a Calcutta's fixed as-of date by default.
 * The current view deliberately uses today's roster and is opt-in.
 */
export async function loadSeasonConsortiums(
  seasonId: number,
  view: MembershipView = "historical",
): Promise<Map<number, string | null>> {
  const season = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, seasonId))
    .limit(1);
  if (!season[0]) return new Map();
  const calcutta = await db
    .select({ asOfDate: calcuttasTable.asOfDate })
    .from(calcuttasTable)
    .where(
      and(
        eq(calcuttasTable.seasonId, seasonId),
        eq(calcuttasTable.sport, "NFL"),
        eq(calcuttasTable.isCanonical, true),
      ),
    )
    .limit(1);
  const anchorDate =
    view === "current"
      ? todayIso()
      : calcutta[0]?.asOfDate ?? `${season[0].year}-08-01`;
  // Synthetic/test seasons can use integer years outside PostgreSQL's date
  // range. They have no meaningful dated roster, but owner reports must
  // continue to load without binding an invalid date parameter.
  if (
    view === "historical" &&
    (season[0].year < 1 || season[0].year > 9999) &&
    !calcutta[0]?.asOfDate
  ) {
    return new Map();
  }

  const memberships = await db
    .select({
      bidderId: consortiumMembershipsTable.bidderId,
      consortium: consortiaTable.name,
      fromDate: consortiumMembershipsTable.fromDate,
    })
    .from(consortiumMembershipsTable)
    .innerJoin(
      consortiaTable,
      eq(consortiaTable.id, consortiumMembershipsTable.consortiumId),
    )
    .where(
      view === "current"
        ? isNull(consortiumMembershipsTable.toDate)
        : and(
            lte(consortiumMembershipsTable.fromDate, anchorDate),
            or(
              isNull(consortiumMembershipsTable.toDate),
              sql`${consortiumMembershipsTable.toDate} > ${anchorDate}`,
            ),
          ),
    )
    .orderBy(consortiumMembershipsTable.fromDate);

  const result = new Map<number, string | null>();
  for (const membership of memberships) {
    result.set(membership.bidderId, membership.consortium);
  }
  const [legacyMemberships, biddersWithMembershipHistory] = await Promise.all([
    loadLegacyBidderConsortiums(),
    loadBiddersWithMembershipHistory(),
  ]);
  return preserveLegacyFallback(
    result as Map<number, string>,
    legacyMemberships,
    biddersWithMembershipHistory,
  );
}

/**
 * Resolves a bidder roster against one Calcutta's own fixed as-of date.
 * Cross-Calcutta reports call this rather than using a season-wide default so
 * an alternate pool can preserve its own historical roster boundary.
 */
export async function loadCalcuttaConsortiums(
  calcuttaId: number,
  view: MembershipView = "historical",
): Promise<Map<number, string | null>> {
  const calcutta = await db
    .select({
      year: calcuttasTable.year,
      asOfDate: calcuttasTable.asOfDate,
    })
    .from(calcuttasTable)
    .where(eq(calcuttasTable.id, calcuttaId))
    .limit(1);
  if (!calcutta[0]) return new Map();

  const anchorDate =
    view === "current"
      ? todayIso()
      : calcutta[0].asOfDate ?? `${calcutta[0].year}-08-01`;
  if (
    view === "historical" &&
    (calcutta[0].year < 1 || calcutta[0].year > 9999) &&
    !calcutta[0].asOfDate
  ) {
    return new Map();
  }

  const memberships = await db
    .select({
      bidderId: consortiumMembershipsTable.bidderId,
      consortium: consortiaTable.name,
      fromDate: consortiumMembershipsTable.fromDate,
    })
    .from(consortiumMembershipsTable)
    .innerJoin(
      consortiaTable,
      eq(consortiaTable.id, consortiumMembershipsTable.consortiumId),
    )
    .where(
      view === "current"
        ? isNull(consortiumMembershipsTable.toDate)
        : and(
            lte(consortiumMembershipsTable.fromDate, anchorDate),
            or(
              isNull(consortiumMembershipsTable.toDate),
              sql`${consortiumMembershipsTable.toDate} > ${anchorDate}`,
            ),
          ),
    )
    .orderBy(consortiumMembershipsTable.fromDate);

  const result = new Map<number, string | null>();
  for (const membership of memberships) {
    result.set(membership.bidderId, membership.consortium);
  }
  const [legacyMemberships, biddersWithMembershipHistory] = await Promise.all([
    loadLegacyBidderConsortiums(),
    loadBiddersWithMembershipHistory(),
  ]);
  return preserveLegacyFallback(
    result as Map<number, string>,
    legacyMemberships,
    biddersWithMembershipHistory,
  );
}