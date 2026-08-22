import { Router, type IRouter, type Request } from "express";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  biddersTable,
  ownershipAdjustmentsTable,
  seasonsTable,
  teamBiddersTable,
  teamResultsTable,
  teamSeasonAuctionsTable,
  teamsTable,
  tradesTable,
  importRunsTable,
  syncSeasonPositions,
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
  DraftOrderImportError,
  fetchDraftOrderPayload,
  teamNameFromAbbrev,
} from "../lib/draftOrderImport";
import {
  OWNERSHIP_SEASON_LOCK_NAMESPACE,
  validatePrimaryOwnership,
} from "../lib/ownershipShares";

const router: IRouter = Router();
const COMPLETE_NFL_TEAM_COUNT = 32;

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

function sourceFingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function assertCompleteImport(teamCount: number, sourceLabel: string): void {
  if (teamCount !== COMPLETE_NFL_TEAM_COUNT) {
    throw new AuctionProImportError(
      `${sourceLabel} must contain all ${COMPLETE_NFL_TEAM_COUNT} NFL teams; received ${teamCount}.`,
      422,
    );
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
    const sourcePayload = await fetchAuctionProPayload();
    const importedTeams = await resolveImportTeams(sourcePayload);
    assertCompleteImport(importedTeams.length, "AuctionPro export");
    const teamIds = importedTeams.map((team) => team.teamId);
    const importedOwners = importedTeams.reduce(
      (count, team) => count + team.owners.length,
      0,
    );
    const sourceHash = sourceFingerprint(sourcePayload);

    const importOutcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonRows[0]!.id})`,
      );
      const previousRun = await tx
        .select({
          importedTeams: importRunsTable.importedTeams,
          importedOwners: importRunsTable.importedOwners,
        })
        .from(importRunsTable)
        .where(
          and(
            eq(importRunsTable.seasonId, seasonRows[0]!.id),
            eq(importRunsTable.source, "auctionpro_json"),
            eq(importRunsTable.sourceHash, sourceHash),
          ),
        )
        .limit(1);
      if (previousRun[0]) {
        return {
          importedTeams: previousRun[0].importedTeams,
          importedOwners: previousRun[0].importedOwners,
        };
      }
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
      await tx.insert(importRunsTable).values({
        seasonId: seasonRows[0]!.id,
        source: "auctionpro_json",
        sourceHash,
        importedTeams: importedTeams.length,
        importedOwners,
        requestedBy: "admin_api",
        requestId: req.id == null ? null : String(req.id),
      });
      await syncSeasonPositions(tx, seasonRows[0]!.id);
      return { importedTeams: importedTeams.length, importedOwners };
    });

    const result = ImportAuctionDataResponse.parse({
      seasonYear: parsed.data.seasonYear,
      importedTeams: importOutcome.importedTeams,
      importedOwners: importOutcome.importedOwners,
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

// ── POST /auction/import/draft-order ─────────────────────────────────────────
// Fetches the public AuctionPro live draft-order endpoint and atomically
// replaces the season's auction prices, single-owner ownership, and draft
// order in team_results. Requires ADMIN_API_KEY. Blocked if approved trades
// already exist for any of the 32 teams.

router.post("/auction/import/draft-order", async (req, res): Promise<void> => {
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
    const rawEntries = await fetchDraftOrderPayload();

    const [teams, bidders] = await Promise.all([
      db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable),
      db.select({ id: biddersTable.id, name: biddersTable.name }).from(biddersTable),
    ]);

    type ResolvedDraftEntry = {
      teamId: number;
      teamName: string;
      bidderId: number;
      bidderName: string;
      bidAmount: number;
      draftOrder: number | null;
    };

    const resolved: ResolvedDraftEntry[] = [];
    const seenTeamIds = new Set<number>();

    for (const entry of rawEntries) {
      const fullName = teamNameFromAbbrev(entry.team);
      if (!fullName) {
        throw new DraftOrderImportError(`Unknown team abbreviation "${entry.team}".`, 422);
      }

      const teamMatch = resolveUniqueByName(teams, fullName, "Team");
      if ("error" in teamMatch) throw new DraftOrderImportError(teamMatch.error, 422);

      if (seenTeamIds.has(teamMatch.id)) {
        throw new DraftOrderImportError(
          `Multiple draft-order entries resolve to team "${teamMatch.name}".`,
          422,
        );
      }
      seenTeamIds.add(teamMatch.id);

      const bidderMatch = resolveUniqueByName(bidders, entry.owner, "Bidder");
      if ("error" in bidderMatch) throw new DraftOrderImportError(bidderMatch.error, 422);

      resolved.push({
        teamId: teamMatch.id,
        teamName: teamMatch.name,
        bidderId: bidderMatch.id,
        bidderName: bidderMatch.name,
        bidAmount: entry.value,
        draftOrder: entry.draftOrder,
      });
    }
    if (resolved.length !== COMPLETE_NFL_TEAM_COUNT) {
      throw new DraftOrderImportError(
        `AuctionPro draft-order export must contain all ${COMPLETE_NFL_TEAM_COUNT} NFL teams; received ${resolved.length}.`,
        422,
      );
    }

    const teamIds = resolved.map((r) => r.teamId);
    const sourceHash = sourceFingerprint(rawEntries);

    const importOutcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonRows[0]!.id})`,
      );
      const previousRun = await tx
        .select({
          importedTeams: importRunsTable.importedTeams,
          importedOwners: importRunsTable.importedOwners,
        })
        .from(importRunsTable)
        .where(
          and(
            eq(importRunsTable.seasonId, seasonRows[0]!.id),
            eq(importRunsTable.source, "auctionpro_draft_order"),
            eq(importRunsTable.sourceHash, sourceHash),
          ),
        )
        .limit(1);
      if (previousRun[0]) {
        return {
          importedTeams: previousRun[0].importedTeams,
          importedOwners: previousRun[0].importedOwners,
        };
      }

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

      // Replace auction prices and primary ownership
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
        resolved.map((r) => ({
          teamId: r.teamId,
          seasonId: seasonRows[0]!.id,
          bidAmount: String(r.bidAmount),
        })),
      );

      await tx.insert(teamBiddersTable).values(
        resolved.map((r) => ({
          teamId: r.teamId,
          bidderId: r.bidderId,
          seasonId: seasonRows[0]!.id,
          ownershipShare: "1",
        })),
      );

      // Upsert draftOrder only — preserves wins, playoff flags, etc.
      for (const r of resolved) {
        await tx
          .insert(teamResultsTable)
          .values({
            teamId: r.teamId,
            seasonId: seasonRows[0]!.id,
            draftOrder: r.draftOrder,
          })
          .onConflictDoUpdate({
            target: [teamResultsTable.teamId, teamResultsTable.seasonId],
            set: { draftOrder: r.draftOrder },
          });
      }

      // Audit log
      await tx.insert(ownershipAdjustmentsTable).values(
        resolved.map((r) => ({
          seasonId: seasonRows[0]!.id,
          teamId: r.teamId,
          source: "draft_order_import",
          note: "AuctionPro live draft-order import",
          owners: {
            bidAmount: r.bidAmount,
            draftOrder: r.draftOrder,
            owners: [
              { bidderId: r.bidderId, bidderName: r.bidderName, ownershipShare: 1 },
            ],
          },
        })),
      );
      await tx.insert(importRunsTable).values({
        seasonId: seasonRows[0]!.id,
        source: "auctionpro_draft_order",
        sourceHash,
        importedTeams: resolved.length,
        importedOwners: resolved.length,
        requestedBy: "admin_api",
        requestId: req.id == null ? null : String(req.id),
      });
      await syncSeasonPositions(tx, seasonRows[0]!.id);
      return { importedTeams: resolved.length, importedOwners: resolved.length };
    });

    const result = ImportAuctionDataResponse.parse({
      seasonYear: parsed.data.seasonYear,
      importedTeams: importOutcome.importedTeams,
      importedOwners: importOutcome.importedOwners,
      source: "AuctionPro live draft-order",
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ApprovedTradeConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof DraftOrderImportError) {
      req.log.warn({ statusCode: error.statusCode }, "Draft-order import rejected");
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Draft-order import failed");
    res.status(502).json({ error: "Draft-order import failed unexpectedly." });
  }
});

export default router;