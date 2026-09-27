import { Router } from "express";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, auctionSessionsTable, calcuttasTable, listenerTicketsTable, listenerSessionsTable, listenerTranscriptEventsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { rateLimit } from "express-rate-limit";
import { snapshot } from "../lib/auctionState";
import { finalizeAuctionSale } from "../lib/finalizeAuctionSale";
import { listenerResultSchema, resultFingerprint } from "../lib/listenerResult";

import { ListenerTickets } from "../lib/listenerTickets";

const router = Router();
const uuid = z.string().uuid();
const listenerSecret = process.env["SESSION_SECRET"];
const allowedProduction = new Set(["https://thecalcutta.app", "https://www.thecalcutta.app"]);

function publicOrigin(): string | null {
  const configured = process.env["LISTENER_PUBLIC_ORIGIN"];
  const origin = configured || (process.env["NODE_ENV"] !== "production" && process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}` : "");
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:") return null;
    if (process.env["NODE_ENV"] === "production" && !allowedProduction.has(origin)) return null;
    return origin;
  } catch { return null; }
}

type Tx = any;
const repository = {
  async createTicket(v: any) {
    await db.transaction(async (tx) => {
      const [auction] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, v.auctionId)).for("update");
      if (!auction || auction.status === "complete") throw new Error("Auction is unavailable or complete.");
      await tx.insert(listenerTicketsTable).values({ ...v, expiresAt: new Date(v.expiresAt) });
    });
  },
  async getSession(id: string) {
    return (await db.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, id)).limit(1))[0];
  },
  async withTicket(hash: string, callback: (tx: any) => Promise<any>) {
    return db.transaction(async (tx) => callback({
      getTicket: async () => (await tx.select().from(listenerTicketsTable).where(eq(listenerTicketsTable.hash, hash)).for("update").limit(1))[0],
      getOpenAuction: async (id: number) => (await tx.select({ id: auctionSessionsTable.id, calcuttaId: calcuttasTable.id, name: calcuttasTable.name, status: auctionSessionsTable.status })
        .from(auctionSessionsTable).innerJoin(calcuttasTable, eq(calcuttasTable.id, auctionSessionsTable.calcuttaId))
        .where(and(eq(auctionSessionsTable.id, id), sql`${auctionSessionsTable.status} <> 'complete'`)).for("update").limit(1))[0],
      getSession: async (id: string) => (await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, id)).for("update").limit(1))[0],
      resumeSession: async (id: string, expiresAt: string) => {
        await tx.update(listenerSessionsTable).set({expiresAt: new Date(expiresAt)}).where(eq(listenerSessionsTable.id, id));
      },
      activateSession: async (session: any) => {
        const old = await tx.select().from(listenerSessionsTable).where(and(eq(listenerSessionsTable.auctionId, session.auctionId), isNull(listenerSessionsTable.revokedAt))).for("update");
        if (old.some((x: any) => x.recording || x.pending > 0)) throw new Error("An active listener is recording or has pending deliveries.");
        for (const row of old) await tx.update(listenerSessionsTable).set({ revokedAt: new Date() }).where(eq(listenerSessionsTable.id, row.id));
        await tx.insert(listenerSessionsTable).values({ ...session, expiresAt: new Date(session.expiresAt) });
      },
      markRedeemed: async ({ redemptionId, sessionId }: any) => {
        await tx.update(listenerTicketsTable).set({ redemptionId, sessionId }).where(eq(listenerTicketsTable.hash, hash));
      },
    }));
  },
};

function tickets(): any | null {
  return listenerSecret && listenerSecret.length >= 32 && publicOrigin() ? new ListenerTickets({ repository, secret: listenerSecret }) : null;
}
function closed(res: any) { return res.status(503).json({ error: "Listener is not configured." }); }
function noStore(res: any) { res.setHeader("Cache-Control", "no-store"); }

router.post("/listener/tickets", requireAdmin, async (req, res) => {
  noStore(res);
  const body = z.object({ auctionId: z.coerce.number().int().positive() }).safeParse(req.body);
  const origin = publicOrigin(); const service = tickets();
  if (!body.success) return res.status(400).json({ error: "auctionId is required." });
  if (!service || !origin) return closed(res);
  try { return res.json(await service.issue(body.data.auctionId, origin)); }
  catch { return res.status(409).json({ error: "Auction is unavailable or complete." }); }
});

const pairLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
router.post("/listener/preview", pairLimiter, async (req, res) => {
  noStore(res); const service = tickets();
  const body = z.object({origin: z.string(), ticket: z.string()}).safeParse(req.body);
  if (!service) return closed(res);
  if (!body.success || body.data.origin !== publicOrigin()) return res.status(401).json({error: "Invalid connection ticket."});
  try { return res.json(await service.preview(body.data)); }
  catch { return res.status(410).json({error: "Invalid or expired connection ticket."}); }
});
router.post("/listener/pair", pairLimiter, async (req, res) => {
  noStore(res); const service = tickets(); const body = z.object({ origin: z.string(), ticket: z.string(), redemptionId: uuid, resume: z.object({id: uuid, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).optional() }).safeParse(req.body);
  if (!service || !publicOrigin()) return closed(res);
  if (!body.success || body.data.origin !== publicOrigin()) return res.status(401).json({ error: "Invalid connection ticket." });
  try { return res.json(await service.redeem(body.data)); }
  catch (e) { return res.status(/expired|used|active/i.test(String(e)) ? 410 : 401).json({ error: "Invalid or expired connection ticket." }); }
});

function bearer(req: any): string | null {
  const value = req.header("authorization"); const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(value ?? ""); return match?.[1] ?? null;
}
async function session(req: any) {
  const id = uuid.parse(req.params.id); const token = bearer(req);
  if (!token) throw new Error("Unauthorized listener.");
  const service = tickets(); if (!service) throw new Error("Listener is not configured.");
  const row = await service.authenticate(id, token);
  if (row.revokedAt || row.expiresAt <= new Date()) throw new Error("Unauthorized listener.");
  return row;
}

const recallEvent = z.object({
  id: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), websiteSessionId: uuid,
  uploadId: z.string().min(1).max(200), receivedAt: z.string().datetime(), event: z.object({
    event: z.enum(["transcript.data", "transcript.partial_data"]), data: z.object({ data: z.object({
      words: z.array(z.union([z.string(), z.object({ text: z.string().optional() }).passthrough()])).max(5000),
      participant: z.union([z.string().max(300), z.object({ id: z.string().optional(), name: z.string().max(300).optional() }).passthrough()]).optional(),
    }).passthrough() }).passthrough(),
  }).passthrough(),
});
router.post("/listener/sessions/:id/events", async (req, res) => {
  try {
    const s = await session(req); const body = z.object({ events: z.array(recallEvent).min(1).max(100) }).safeParse(req.body);
    if (!body.success || body.data.events.some(e => e.websiteSessionId !== s.id)) return res.status(400).json({ error: "Invalid event batch." });
    const bytes = Buffer.byteLength(JSON.stringify(req.body)); if (bytes > 256 * 1024) return res.status(413).json({ error: "Event batch is too large." });
    const acceptedIds = await db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, s.id));
      const [auction] = candidate ? await tx.select({ status: auctionSessionsTable.status }).from(auctionSessionsTable).where(eq(auctionSessionsTable.id, candidate.auctionId)).for("update") : [];
      const [locked] = candidate ? await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, s.id)).for("update") : [];
      if (!locked || locked.revokedAt || locked.expiresAt <= new Date() || !auction || auction.status === "complete") throw new Error("Unauthorized listener.");
      for (const event of body.data.events) {
        const words = event.event.data.data.words.map((w: any) => typeof w === "string" ? w : typeof w?.text === "string" ? w.text : "").filter(Boolean).join(" ");
        const participant = typeof event.event.data.data.participant === "string" ? event.event.data.data.participant : event.event.data.data.participant?.name;
        await tx.insert(listenerTranscriptEventsTable).values({ listenerSessionId: s.id, eventId: event.id, localSessionId: event.sessionId, uploadId: event.uploadId, websiteSessionId: event.websiteSessionId, receivedAt: new Date(), eventType: event.event.event, transcript: words.slice(0, 100_000), participant }).onConflictDoNothing();
      }
      await tx.update(listenerSessionsTable).set({ lastSeenAt: new Date() }).where(eq(listenerSessionsTable.id, s.id));
      return body.data.events.map(e => e.id);
    });
    return res.json({ acceptedIds });
  } catch { return res.status(401).json({ error: "Unauthorized listener." }); }
});

// An authenticated, auction-scoped snapshot. No admin/Recall credential is sent to the desktop.
router.get("/listener/sessions/:id/context", async (req, res) => {
  noStore(res);
  try {
    const s = await session(req);
    // Serialize against nomination, roster edits, and sale transactions.
    const context = await db.transaction(async (tx) => {
      const [auction] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, s.auctionId)).for("update");
      const [credential] = await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, s.id)).for("update");
      if (!auction || auction.status === "complete" || !credential || credential.revokedAt || credential.expiresAt <= new Date()) throw new Error("Unauthorized listener.");
      const value = await snapshot(s.auctionId, tx);
      if (!value) throw new Error("Auction unavailable.");
      return { ...value, protocolVersion: 2, serverTime: new Date().toISOString(), currentLotId: value.lots.find(l => l.id === value.currentLotId && l.status === "bidding")?.id ?? null };
    });
    return res.json(context);
  } catch { return res.status(401).json({ error: "Reconnect the listener from an open auction." }); }
});

router.post("/listener/sessions/:id/results", async (req, res) => {
  noStore(res);
  let s;
  try { s = await session(req); }
  catch { return res.status(401).json({ error: "Reconnect the listener from the website." }); }
  const parsed = listenerResultSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Check the lot, winners, amount and ownership percentages." });
  try {
    const [auction] = await db.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, s.auctionId));
    if (!auction) return res.status(404).json({ error: "Auction unavailable." });
    const input = parsed.data;
    const result = await finalizeAuctionSale(auction.calcuttaId, s.auctionId, input.lotId, {
      totalCents: input.totalCents,
      allocations: input.allocations.map(a => ({ consortiumId: a.consortiumId, share: a.basisPoints / 10000 })),
    }, { id: s.id, nominationId: input.nominationId, key: `listener:${s.id}:${input.idempotencyKey}`, requestId: input.idempotencyKey, fingerprint: resultFingerprint(input) });
    return res.json(result);
  } catch (error) {
    // Constraint/database internals must not be reflected to the desktop.
    const message = error instanceof Error ? error.message : "";
    const known = /^(Listener session expired|Submission ID was already used|The nominated lot changed|Auction is complete|Approved trades protect|This entry already has|Every buyer must|Every owner must|Every expanded owner|The selected consortium|Expanded allocations|Invalid sale price)/.test(message);
    return res.status(known ? 409 : 503).json({ error: known ? message : "Result could not be saved. Retry when the website is available." });
  }
});

router.post("/listener/sessions/:id/heartbeat", async (req, res) => {
  try {
    const s = await session(req); const body = z.object({ recording: z.boolean(), pending: z.number().int().nonnegative().max(10000).optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid heartbeat." });
    await db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, s.id));
      const [auction] = candidate ? await tx.select({ status: auctionSessionsTable.status }).from(auctionSessionsTable).where(eq(auctionSessionsTable.id, candidate.auctionId)).for("update") : [];
      const [locked] = candidate ? await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, s.id)).for("update") : [];
      if (!locked || locked.revokedAt || locked.expiresAt <= new Date() || !auction || auction.status === "complete") throw new Error("Unauthorized listener.");
      await tx.update(listenerSessionsTable).set({ lastSeenAt: new Date(), recording: body.data.recording, pending: body.data.pending ?? 0 }).where(eq(listenerSessionsTable.id, s.id));
    });
    return res.json({ ok: true });
  } catch { return res.status(401).json({ error: "Unauthorized listener." }); }
});

router.get("/listener/status", requireAdmin, async (req, res) => {
  noStore(res); if (!tickets()) return closed(res); const auctionId = Number(req.query.auctionId); if (!Number.isInteger(auctionId)) return res.status(400).json({ error: "auctionId is required." });
  const rows = await db.select().from(listenerSessionsTable).where(and(eq(listenerSessionsTable.auctionId, auctionId), isNull(listenerSessionsTable.revokedAt), gt(listenerSessionsTable.expiresAt, new Date()))).orderBy(asc(listenerSessionsTable.lastSeenAt));
  const active = rows.at(-1); const latest = active ? (await db.select({ transcript: listenerTranscriptEventsTable.transcript }).from(listenerTranscriptEventsTable).where(eq(listenerTranscriptEventsTable.listenerSessionId, active.id)).orderBy(sql`${listenerTranscriptEventsTable.receivedAt} desc`).limit(1))[0]?.transcript ?? null : null;
  return res.json({ connected: !!active?.lastSeenAt && Date.now() - active.lastSeenAt.getTime() <= 30_000, recording: active?.recording ?? false, pending: active?.pending ?? 0, latestTranscript: latest });
});

// Public read-only transcript projection. It intentionally exposes no bearer
// credentials or raw provider payload, and is only available for an open/live
// auction (historical transcripts remain an admin concern).
router.get("/listener/auction-view", async (req, res) => {
  if (!tickets()) return closed(res);
  const auctionId = Number(req.query.auctionId);
  if (!Number.isInteger(auctionId)) return res.status(400).json({ error: "auctionId is required." });
  const [auction] = await db.select({ status: auctionSessionsTable.status }).from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).limit(1);
  if (!auction || auction.status === "complete") return res.status(404).json({ error: "Auction not found." });
  const rows = await db.select({
    sessionId: listenerSessionsTable.id, recording: listenerSessionsTable.recording,
    pending: listenerSessionsTable.pending, lastSeenAt: listenerSessionsTable.lastSeenAt,
    id: listenerTranscriptEventsTable.id, text: listenerTranscriptEventsTable.transcript,
    partial: listenerTranscriptEventsTable.eventType,
    receivedAt: listenerTranscriptEventsTable.receivedAt,
  }).from(listenerSessionsTable).leftJoin(listenerTranscriptEventsTable, eq(listenerTranscriptEventsTable.listenerSessionId, listenerSessionsTable.id))
    .where(and(eq(listenerSessionsTable.auctionId, auctionId), isNull(listenerSessionsTable.revokedAt), gt(listenerSessionsTable.expiresAt, new Date())))
    .orderBy(sql`${listenerTranscriptEventsTable.receivedAt} desc`).limit(100);
  rows.reverse();
  const latest = rows.reduce((a, b) => !a || (b.lastSeenAt && (!a.lastSeenAt || b.lastSeenAt > a.lastSeenAt)) ? b : a, rows[0]);
  return res.json({
    connected: !!latest?.lastSeenAt && Date.now() - latest.lastSeenAt.getTime() <= 30_000,
    recording: latest?.recording ?? false, pending: latest?.pending ?? 0, lastSeenAt: latest?.lastSeenAt ?? null,
    transcripts: rows.filter(r => r.id != null).map(r => ({ id: r.id, text: r.text, partial: r.partial === "transcript.partial_data", receivedAt: r.receivedAt })),
  });
});

router.post("/listener/revoke", requireAdmin, async (req, res) => {
  noStore(res);
  const body = z.object({ sessionId: uuid }).safeParse(req.body); if (!body.success) return res.status(400).json({ error: "sessionId is required." });
  await db.transaction(async (tx) => {
    const [s] = await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, body.data.sessionId)).for("update");
    if (!s) return;
    const [auction] = await tx.select({ status: auctionSessionsTable.status }).from(auctionSessionsTable).where(eq(auctionSessionsTable.id, s.auctionId)).for("update");
    if (auction?.status !== "complete") await tx.update(listenerSessionsTable).set({ revokedAt: new Date(), recording: false, pending: 0 }).where(eq(listenerSessionsTable.id, s.id));
  });
  return res.json({ ok: true });
});
export default router;
