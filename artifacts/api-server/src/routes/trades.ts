import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  biddersTable,
  tradesTable,
  seasonsTable,
  positionsTable,
  calcuttaEntriesTable,
} from "@workspace/db";
import {
  GetTradesQueryParams,
  CreateTradeBody,
  UpdateTradeBody,
  DeleteTradeParams,
  UpdateTradeParams,
  SetTradeStatusBody,
  SetTradeStatusParams,
  GetTradesResponse,
  CreateTradeResponse,
  UpdateTradeResponse,
  SetTradeStatusResponse,
} from "@workspace/api-zod";
import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";
import { resolveCalcuttaId } from "../lib/calcuttaContext";
import { createPendingTrade, validateTradeOwnership as validateSharedTradeOwnership } from "../lib/tradeService";
import { requireAdmin } from "../middlewares/requireAdmin";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";

const router: IRouter = Router();

// ── Ownership-integrity validation ────────────────────────────────────────────
async function validateTradeOwnership(args: {
  seasonId: number;
  teamId: number;
  entryId?: number;
  fromBidderId: number;
  toBidderId: number;
  percentage: number;
}, query: Pick<typeof db, "select"> = db, requireCompletePrimaryOwnership = false): Promise<string | null> {
  if (args.entryId == null) {
    return "Team is not an entry in the selected Calcutta.";
  }
  return validateSharedTradeOwnership({
    entryId: args.entryId,
    fromBidderId: args.fromBidderId,
    toBidderId: args.toBidderId,
    percentage: args.percentage,
  }, query, requireCompletePrimaryOwnership);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveSeasonId(year: number): Promise<number | null> {
  const rows = await db
    .select({ id: seasonsTable.id })
    .from(seasonsTable)
    .where(eq(seasonsTable.year, year))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function enrichTrade(tradeId: number) {
  const rows = await db
    .select({
      id: tradesTable.id,
      seasonId: tradesTable.seasonId,
      teamId: tradesTable.teamId,
      teamName: teamsTable.name,
      fromBidderId: tradesTable.fromBidderId,
      fromBidderName: biddersTable.name,
      toBidderId: tradesTable.toBidderId,
      price: tradesTable.price,
      percentage: tradesTable.percentage,
      status: tradesTable.status,
      decisionAt: tradesTable.decisionAt,
      decisionSource: tradesTable.decisionSource,
      voidedAt: tradesTable.voidedAt,
      voidedSource: tradesTable.voidedSource,
      voidReason: tradesTable.voidReason,
      tradeDate: tradesTable.tradeDate,
      notes: tradesTable.notes,
    })
    .from(tradesTable)
    .innerJoin(teamsTable, eq(tradesTable.teamId, teamsTable.id))
    .innerJoin(biddersTable, eq(tradesTable.fromBidderId, biddersTable.id))
    .where(eq(tradesTable.id, tradeId))
    .limit(1);

  if (!rows[0]) return null;
  const row = rows[0];

  const biddersAll = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const bidderNameMap = new Map(biddersAll.map((b) => [b.id, b.name]));

  const seasonInfo = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, row.seasonId))
    .limit(1);

  return {
    id: row.id,
    seasonYear: seasonInfo[0]?.year ?? 0,
    teamId: row.teamId,
    teamName: row.teamName,
    fromBidderId: row.fromBidderId,
    fromBidderName: row.fromBidderName,
    toBidderId: row.toBidderId,
    toBidderName: bidderNameMap.get(row.toBidderId) ?? "Unknown",
    price: parseFloat(row.price),
    percentage: parseFloat(row.percentage),
    status: row.status,
    decisionAt: row.decisionAt,
    decisionSource: row.decisionSource,
    voidedAt: row.voidedAt,
    voidedSource: row.voidedSource,
    voidReason: row.voidReason,
    tradeDate: row.tradeDate,
    notes: row.notes,
  };
}

// ── GET /trades ──────────────────────────────────────────────────────────────

router.get("/admin/validate", requireAdmin, (_req: Request, res: Response): void => {
  res.status(204).send();
});

router.get("/trades", async (req, res): Promise<void> => {
  const parsed = GetTradesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const { season } = parsed.data as typeof parsed.data & { calcuttaId?: number };
  const seasonId = await resolveSeasonId(season);
  if (!seasonId) {
    sendParsedJson(res, GetTradesResponse, []);
    return;
  }
  const calcuttaId = await resolveCalcuttaId(db, { seasonId, calcuttaId: parsed.data.calcuttaId });
  if (!calcuttaId) {
    sendParsedJson(res, GetTradesResponse, []);
    return;
  }

  const rows = await db
    .select({
      id: tradesTable.id,
      seasonId: tradesTable.seasonId,
      teamId: tradesTable.teamId,
      teamName: teamsTable.name,
      fromBidderId: tradesTable.fromBidderId,
      fromBidderName: biddersTable.name,
      toBidderId: tradesTable.toBidderId,
      price: tradesTable.price,
      percentage: tradesTable.percentage,
      status: tradesTable.status,
      decisionAt: tradesTable.decisionAt,
      decisionSource: tradesTable.decisionSource,
      voidedAt: tradesTable.voidedAt,
      voidedSource: tradesTable.voidedSource,
      voidReason: tradesTable.voidReason,
      tradeDate: tradesTable.tradeDate,
      notes: tradesTable.notes,
    })
    .from(tradesTable)
    .innerJoin(teamsTable, eq(tradesTable.teamId, teamsTable.id))
    .innerJoin(biddersTable, eq(tradesTable.fromBidderId, biddersTable.id))
    .where(and(
      eq(tradesTable.seasonId, seasonId),
      sql`${tradesTable.entryId} in (select id from calcutta_entries where calcutta_id = ${calcuttaId})`,
    ))
    .orderBy(tradesTable.tradeDate);

  const biddersAll = await db
    .select({ id: biddersTable.id, name: biddersTable.name })
    .from(biddersTable);
  const bidderNameMap = new Map(biddersAll.map((b) => [b.id, b.name]));

  const seasonInfo = await db
    .select({ year: seasonsTable.year })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, seasonId))
    .limit(1);

  sendParsedJson(res, GetTradesResponse,
    rows.map((r) => ({
      id: r.id,
      seasonYear: seasonInfo[0]?.year ?? 0,
      teamId: r.teamId,
      teamName: r.teamName,
      fromBidderId: r.fromBidderId,
      fromBidderName: r.fromBidderName,
      toBidderId: r.toBidderId,
      toBidderName: bidderNameMap.get(r.toBidderId) ?? "Unknown",
      price: parseFloat(r.price),
      percentage: parseFloat(r.percentage),
      status: r.status,
      decisionAt: r.decisionAt,
      decisionSource: r.decisionSource,
      voidedAt: r.voidedAt,
      voidedSource: r.voidedSource,
      voidReason: r.voidReason,
      tradeDate: r.tradeDate,
      notes: r.notes,
    })),
  );
});

// ── POST /trades — anyone can create; always starts as pending ────────────────

router.post("/trades", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  const data = parsed.data as typeof parsed.data & { calcuttaId?: number };
  if (data.price !== undefined && (!Number.isFinite(data.price) || data.price < 0)) {
    sendParsedJson(res, ErrorResponse, { error: "Trade price must be a non-negative number." }, 400);
    return;
  }
  const seasonId = await resolveSeasonId(data.seasonYear);
  if (!seasonId) {
    sendParsedJson(res, ErrorResponse, { error: `Season ${data.seasonYear} not found` }, 400);
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${seasonId})`,
    );
    const created = await createPendingTrade(tx, {
      seasonId,
      calcuttaId: data.calcuttaId,
      teamId: data.teamId,
      fromBidderId: data.fromBidderId,
      toBidderId: data.toBidderId,
      percentage: data.percentage,
      price: data.price ?? undefined,
      tradeDate: data.tradeDate,
      notes: data.notes,
    });
    return created.ok
      ? { kind: "created" as const, tradeId: created.tradeId }
      : { kind: "invalid" as const, error: created.error };
  });

  if (outcome.kind === "invalid") {
    sendParsedJson(res, ErrorResponse, { error: outcome.error }, 400);
    return;
  }

  const enriched = await enrichTrade(outcome.tradeId);
  sendParsedJson(res, CreateTradeResponse, enriched, 201);
});

// ── PATCH /trades/:id — update price, date, notes, percentage (not status) ──

router.patch("/trades/:id", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const params = UpdateTradeParams.safeParse(req.params);
  const body = UpdateTradeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendParsedJson(res, ErrorResponse, { error: "Invalid request" }, 400);
    return;
  }

  if (body.data.price !== undefined && (!Number.isFinite(body.data.price) || body.data.price < 0)) {
    sendParsedJson(res, ErrorResponse, { error: "Trade price must be a non-negative number." }, 400);
    return;
  }

  // Serialize every trade edit with approvals and primary ownership writes.
  // This makes an approved trade immutable and avoids a pending percentage
  // changing between an approval's validation and its status transition.
  const updateResult = await db.transaction(async (tx) => {
    const initial = await tx
      .select({ seasonId: tradesTable.seasonId })
      .from(tradesTable)
      .where(eq(tradesTable.id, params.data.id))
      .limit(1);
    if (!initial[0]) return { kind: "not_found" as const };

    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${initial[0].seasonId})`,
    );
    const fresh = await tx
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.id, params.data.id))
      .limit(1);
    if (!fresh[0]) return { kind: "not_found" as const };
    if (fresh[0].status !== "pending") return { kind: "decided" as const };

    if (body.data.percentage !== undefined) {
      const validationError = await validateTradeOwnership({
        seasonId: fresh[0].seasonId,
        teamId: fresh[0].teamId,
        fromBidderId: fresh[0].fromBidderId,
        toBidderId: fresh[0].toBidderId,
        percentage: body.data.percentage,
        entryId: fresh[0].entryId,
      }, tx);
      if (validationError) return { kind: "invalid" as const, error: validationError };
    }

    const updates: Partial<typeof tradesTable.$inferInsert> = {};
    if (body.data.price !== undefined) updates.price = body.data.price.toString();
    if (body.data.tradeDate !== undefined) updates.tradeDate = body.data.tradeDate;
    if (body.data.notes !== undefined) updates.notes = body.data.notes;
    if (body.data.percentage !== undefined) updates.percentage = body.data.percentage.toString();
    await tx.update(tradesTable).set(updates).where(eq(tradesTable.id, params.data.id));
    return { kind: "updated" as const };
  });

  if (updateResult.kind === "not_found") {
    sendParsedJson(res, ErrorResponse, { error: "Trade not found" }, 404);
    return;
  }
  if (updateResult.kind === "decided") {
    sendParsedJson(res, ErrorResponse, { error: "Decided trades are immutable. Record a new trade instead." }, 409);
    return;
  }
  if (updateResult.kind === "invalid") {
    sendParsedJson(res, ErrorResponse, { error: `Cannot update trade: ${updateResult.error}` }, 400);
    return;
  }

  const enriched = await enrichTrade(params.data.id);
  sendParsedJson(res, UpdateTradeResponse, enriched);
});

// ── PATCH /trades/:id/status — commissioner confirmation only ───────────────

router.patch("/trades/:id/status", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const params = SetTradeStatusParams.safeParse(req.params);
  if (!params.success) {
    sendParsedJson(res, ErrorResponse, { error: "Invalid trade id" }, 400);
    return;
  }
  const id = params.data.id;

  const body = SetTradeStatusBody.safeParse(req.body);
  if (!body.success) {
    sendParsedJson(res, ErrorResponse, {
      error: 'Body must be { "status": "approved" | "rejected" | "voided", "confirmed": true, "reason"?: string }',
    }, 400);
    return;
  }
  if (body.data.status === "voided" && !body.data.reason?.trim()) {
    sendParsedJson(res, ErrorResponse, { error: "Voiding an approved trade requires a non-empty reason." }, 400);
    return;
  }

  // Serialize decisions with primary ownership changes. A status can transition
  // from pending to approved/rejected, or an approved trade can be corrected to
  // rejected or voided. Rejected and voided trades cannot be decided again.
  const decision = await db.transaction(async (tx) => {
    const initial = await tx
      .select({ seasonId: tradesTable.seasonId })
      .from(tradesTable)
      .where(eq(tradesTable.id, id))
      .limit(1);
    if (!initial[0]) return { kind: "not_found" as const };

    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${initial[0].seasonId})`,
    );
    const fresh = await tx
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.id, id))
      .limit(1);
    if (!fresh[0]) return { kind: "not_found" as const };
    const canCorrectApprovedTrade =
      fresh[0].status === "approved" &&
      (body.data.status === "rejected" || body.data.status === "voided");
    if (fresh[0].status !== "pending" && !canCorrectApprovedTrade) {
      return { kind: "already_decided" as const };
    }
    if (body.data.status === "voided" && fresh[0].status !== "approved") {
      return { kind: "invalid" as const, error: "Only an approved trade can be voided." };
    }

    if (body.data.status === "approved") {
      const validationError = await validateTradeOwnership({
        seasonId: fresh[0].seasonId,
        teamId: fresh[0].teamId,
        fromBidderId: fresh[0].fromBidderId,
        toBidderId: fresh[0].toBidderId,
        percentage: Number(fresh[0].percentage),
        entryId: fresh[0].entryId,
      }, tx, true);
      if (validationError) return { kind: "invalid" as const, error: validationError };
    }

    const now = new Date();
    const updates: Partial<typeof tradesTable.$inferInsert> = {
      status: body.data.status,
    };
    if (body.data.status === "voided") {
      updates.voidedAt = now;
      updates.voidedSource = "commissioner_api";
      updates.voidReason = body.data.reason!.trim();
    } else {
      updates.decisionAt = now;
      updates.decisionSource = "commissioner_api";
    }
    await tx.update(tradesTable).set(updates).where(eq(tradesTable.id, id));
    if (body.data.status === "approved") {
      const share = Number(fresh[0].percentage) / 100;
      const price = Number(fresh[0].price);
      await tx.insert(positionsTable).values([
        { entryId: fresh[0].entryId, bidderId: fresh[0].fromBidderId, ownershipShare: (-share).toFixed(6), source: "trade", costBasis: (-price).toFixed(2), tradeId: fresh[0].id },
        { entryId: fresh[0].entryId, bidderId: fresh[0].toBidderId, ownershipShare: share.toFixed(6), source: "trade", costBasis: price.toFixed(2), tradeId: fresh[0].id },
      ]);
    } else if (fresh[0].status === "approved") {
      // Rejected corrections and voids remove only this trade's signed legs.
      await tx.delete(positionsTable).where(eq(positionsTable.tradeId, fresh[0].id));
    }
    return { kind: "recorded" as const };
  });

  if (decision.kind === "not_found") {
    sendParsedJson(res, ErrorResponse, { error: "Trade not found" }, 404);
    return;
  }
  if (decision.kind === "already_decided") {
    sendParsedJson(res, ErrorResponse, {
      error: "This trade cannot be changed from its current status. Pending trades can be approved or rejected; approved trades can be rejected or voided.",
    }, 409);
    return;
  }
  if (decision.kind === "invalid") {
    sendParsedJson(res, ErrorResponse, { error: `Cannot approve trade: ${decision.error}` }, 400);
    return;
  }

  req.log.info(
    { tradeId: id, status: body.data.status, decisionSource: "commissioner_api" },
    "Commissioner trade decision recorded",
  );
  const enriched = await enrichTrade(id);
  sendParsedJson(res, SetTradeStatusResponse, enriched);
});

// ── DELETE /trades/:id ────────────────────────────────────────────────────────

router.delete("/trades/:id", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = DeleteTradeParams.safeParse(req.params);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: "Invalid id" }, 400);
    return;
  }

  const deleteResult = await db.transaction(async (tx) => {
    const initial = await tx
      .select({ seasonId: tradesTable.seasonId })
      .from(tradesTable)
      .where(eq(tradesTable.id, parsed.data.id))
      .limit(1);
    if (!initial[0]) return "not_found" as const;

    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${initial[0].seasonId})`,
    );
    const fresh = await tx
      .select({ status: tradesTable.status })
      .from(tradesTable)
      .where(eq(tradesTable.id, parsed.data.id))
      .limit(1);
    if (!fresh[0]) return "not_found" as const;
    if (fresh[0].status !== "pending") return "decided" as const;

    await tx.delete(tradesTable).where(eq(tradesTable.id, parsed.data.id));
    return "deleted" as const;
  });
  if (deleteResult === "not_found") {
    sendParsedJson(res, ErrorResponse, { error: "Trade not found" }, 404);
    return;
  }
  if (deleteResult === "decided") {
    sendParsedJson(res, ErrorResponse, { error: "Decided trades cannot be deleted. Record a new trade instead." }, 409);
    return;
  }
  res.status(204).send();
});

export default router;
