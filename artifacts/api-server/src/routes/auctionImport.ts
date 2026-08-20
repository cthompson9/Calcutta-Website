import { Router, type IRouter, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  biddersTable,
  ownershipAdjustmentsTable,
  seasonsTable,
  teamBiddersTable,
  teamSeasonAuctionsTable,
  teamsTable,
  tradesTable,
} from "@workspace/db";
import {
  ImportAuctionDataBody,
  ImportAuctionDataResponse,
} from "@workspace/api-zod";
import {
  AuctionProImportError,
  fetchAuctionProPayload,
  type AuctionProTeam,
} from "../lib/auctionProImport";
import {
  OWNERSHIP_SEASON_LOCK_NAMESPACE,
  validatePrimaryOwnership,
} from "../lib/ownershipShares";

const router: IRouter = Router();

function isAdminRequest(req: Request): boolean {
  const adminKey = process.env["ADMIN_API_KEY"];
  return Boolean(adminKey && req.headers.authorization === `Bearer ${adminKey}`);
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function resolveUniqueByName<T extends { id: number; name: string }>(
  rows: T[],
  requestedName: string,
  label: string,
): T | { error: string } {
  const exact = rows.filter((row) => normalized(row.name) === normalized(requestedName));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { error: `${label} "${requestedName}" is ambiguous.` };

  const partial = rows.filter((row) =>
    normalized(row.name).includes(normalized(requestedName)) ||
    normalized(requestedName).includes(normalized(row.name)),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) return { error: `${label} "${requestedName}" was not found.` };
  return { error: `${label} "${requestedName}" is ambiguous. Use the full registered name.` };
}

type ResolvedImportTeam = {
  teamId: number;
  teamName: string;
  bidAmount: number;
  owners: Array<{ bidderId: number; bidderName: string; share: number }>;
};

class ApprovedTradeConflictError extends Error {
  constructor() {
    super("This season has approved trades. Import would replace the primary auction ownership and is blocked to preserve trade history.");
    this.name = "ApprovedTradeConflictError";
  }
}

async function resolveImportTeams(sourceTeams: AuctionProTeam[]): Promise<ResolvedImportTeam[]> {
  const [teams, bidders] = await Promise.all([
    db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable),
    db.select({ id: biddersTable.id, name: biddersTable.name }).from(biddersTable),
  ]);

  const resolved: ResolvedImportTeam[] = [];
  const teamIds = new Set<number>();
  for (const sourceTeam of sourceTeams) {
    const teamMatch = resolveUniqueByName(teams, sourceTeam.teamName, "Team");
    if ("error" in teamMatch) throw new AuctionProImportError(teamMatch.error, 422);
    if (teamIds.has(teamMatch.id)) {
      throw new AuctionProImportError(
        `AuctionPro export resolves more than one row to ${teamMatch.name}.`,
        422,
      );
    }
    teamIds.add(teamMatch.id);

    const owners: ResolvedImportTeam["owners"] = [];
    for (const sourceOwner of sourceTeam.owners) {
      const bidderMatch = resolveUniqueByName(bidders, sourceOwner.name, "Bidder");
      if ("error" in bidderMatch) throw new AuctionProImportError(bidderMatch.error, 422);
      owners.push({
        bidderId: bidderMatch.id,
        bidderName: bidderMatch.name,
        share: sourceOwner.share,
      });
    }
    const ownership = validatePrimaryOwnership(
      owners.map((owner) => ({ bidderId: owner.bidderId, share: owner.share })),
    );
    if (!ownership.ok) {
      throw new AuctionProImportError(`${teamMatch.name}: ${ownership.error}`, 422);
    }

    resolved.push({
      teamId: teamMatch.id,
      teamName: teamMatch.name,
      bidAmount: sourceTeam.bidAmount,
      owners: owners.map((owner) => {
        const normalizedOwner = ownership.owners.find((entry) => entry.bidderId === owner.bidderId)!;
        return { ...owner, share: normalizedOwner.share };
      }),
    });
  }

  return resolved;
}

router.post("/auction/import", async (req, res): Promise<void> => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: "ADMIN_API_KEY bearer token is required." });
    return;
  }

  const parsed = ImportAuctionDataBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const seasonRows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, parsed.data.seasonYear))
    .limit(1);
  if (!seasonRows[0]) {
    res.status(404).json({ error: `Season ${parsed.data.seasonYear} not found.` });
    return;
  }

  try {
    const importedTeams = await resolveImportTeams(await fetchAuctionProPayload());
    const teamIds = importedTeams.map((team) => team.teamId);

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonRows[0]!.id})`,
      );
      const approvedTrades = await tx
        .select({ teamId: tradesTable.teamId })
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.seasonId, seasonRows[0]!.id),
            eq(tradesTable.status, "approved"),
            inArray(tradesTable.teamId, teamIds),
          ),
        )
        .limit(1);
      if (approvedTrades[0]) throw new ApprovedTradeConflictError();

      await tx
        .delete(teamBiddersTable)
        .where(
          and(
            eq(teamBiddersTable.seasonId, seasonRows[0]!.id),
            inArray(teamBiddersTable.teamId, teamIds),
          ),
        );
      await tx
        .delete(teamSeasonAuctionsTable)
        .where(
          and(
            eq(teamSeasonAuctionsTable.seasonId, seasonRows[0]!.id),
            inArray(teamSeasonAuctionsTable.teamId, teamIds),
          ),
        );

      await tx.insert(teamSeasonAuctionsTable).values(
        importedTeams.map((team) => ({
          teamId: team.teamId,
          seasonId: seasonRows[0]!.id,
          bidAmount: String(team.bidAmount),
        })),
      );
      await tx.insert(teamBiddersTable).values(
        importedTeams.flatMap((team) =>
          team.owners.map((owner) => ({
            teamId: team.teamId,
            bidderId: owner.bidderId,
            seasonId: seasonRows[0]!.id,
            ownershipShare: String(owner.share),
          })),
        ),
      );
      await tx.insert(ownershipAdjustmentsTable).values(
        importedTeams.map((team) => ({
          seasonId: seasonRows[0]!.id,
          teamId: team.teamId,
          source: "auctionpro_import",
          note: "Complete AuctionPro JSON export import",
          owners: {
            bidAmount: team.bidAmount,
            owners: team.owners.map((owner) => ({
              bidderId: owner.bidderId,
              bidderName: owner.bidderName,
              ownershipShare: owner.share,
            })),
          },
        })),
      );
    });

    const result = ImportAuctionDataResponse.parse({
      seasonYear: parsed.data.seasonYear,
      importedTeams: importedTeams.length,
      importedOwners: importedTeams.reduce((count, team) => count + team.owners.length, 0),
      source: "AuctionPro JSON export",
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ApprovedTradeConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof AuctionProImportError) {
      req.log.warn({ statusCode: error.statusCode }, "AuctionPro import rejected");
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "AuctionPro import failed");
    res.status(502).json({ error: "AuctionPro import failed unexpectedly." });
  }
});

export default router;