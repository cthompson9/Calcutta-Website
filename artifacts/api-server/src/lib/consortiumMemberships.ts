import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  calcuttasTable,
  consortiumMembershipsTable,
  consortiaTable,
  db,
  seasonsTable,
} from "@workspace/db";

export type MembershipView = "historical" | "current";

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
  return result;
}