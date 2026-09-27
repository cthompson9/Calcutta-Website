import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ticketShape = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export class ListenerTickets {
  repository: any; secret!: string; now: () => number = Date.now;
  constructor(options: any) { if (typeof options.secret !== "string" || options.secret.length < 32) throw new Error("Listener signing secret must contain at least 32 characters."); Object.assign(this, options); }
  async issue(auctionId: number, origin: string) {
    if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw new Error("HTTPS origin required.");
    const ticket = randomBytes(32).toString("base64url"); const expiresAt = new Date(this.now() + 90_000).toISOString();
    await this.repository.createTicket({ hash: digest(ticket), auctionId, origin, expiresAt });
    return { launchUrl: `calcutta-listener://connect#${new URLSearchParams({ origin, ticket })}`, expiresAt };
  }
  async preview({ticket, origin}: any) {
    if (!ticketShape(ticket)) throw new Error("Invalid connection ticket.");
    return this.repository.withTicket(digest(ticket), async (tx: any) => {
      const row = await tx.getTicket();
      if (!row || row.origin !== origin || Date.parse(row.expiresAt) <= this.now()) throw new Error("Connection link expired.");
      const auction = await tx.getOpenAuction(row.auctionId);
      if (!auction) throw new Error("Auction is unavailable or complete.");
      return {auction};
    });
  }
  async redeem({ ticket, redemptionId, origin, resume }: any) {
    if (!ticketShape(ticket) || !/^[0-9a-f-]{36}$/.test(redemptionId ?? "")) throw new Error("Invalid connection ticket.");
    return this.repository.withTicket(digest(ticket), async (tx: any) => {
      const row = await tx.getTicket();
      if (!row || row.origin !== origin || Date.parse(row.expiresAt) <= this.now()) throw new Error("Connection link expired.");
      const auction = await tx.getOpenAuction(row.auctionId); if (!auction) throw new Error("Auction is unavailable or complete.");
      if (row.redemptionId && row.redemptionId !== redemptionId) throw new Error("Connection ticket already used.");
      // Keep the same receipt namespace and pending deliveries when this device reconnects.
      if (resume) {
        if (row.sessionId && row.sessionId !== resume.id) throw new Error("Connection ticket already used.");
        const existing = await tx.getSession(resume.id);
        if (existing && existing.auctionId === row.auctionId && !existing.revokedAt && !existing.recording &&
            ticketShape(resume.token) && existing.tokenHash.length === 64 && timingSafeEqual(Buffer.from(existing.tokenHash), Buffer.from(digest(resume.token)))) {
          const expiresAt = new Date(this.now() + 43_200_000).toISOString();
          await tx.resumeSession(existing.id, expiresAt);
          await tx.markRedeemed({redemptionId, sessionId: existing.id});
          return {id: existing.id, token: resume.token, expiresAt, auction};
        }
        throw new Error("Existing listener could not be resumed. Resolve its connection before replacing it.");
      }
      const token = createHmac("sha256", this.secret).update(`calcutta-listener-v1:${row.hash}:${redemptionId}`).digest("base64url");
      if (row.sessionId) { const existing = await tx.getSession(row.sessionId); if (!existing || existing.revokedAt || Date.parse(existing.expiresAt) <= this.now()) throw new Error("Listener session is no longer active."); return { id: existing.id, token, expiresAt: existing.expiresAt, auction }; }
      const session = { id: randomUUID(), auctionId: row.auctionId, tokenHash: digest(token), expiresAt: new Date(this.now() + 43_200_000).toISOString() };
      await tx.activateSession(session); await tx.markRedeemed({ redemptionId, sessionId: session.id }); return { id: session.id, token, expiresAt: session.expiresAt, auction };
    });
  }
  async authenticate(id: string, token: string) {
    if (!ticketShape(token) || !/^[0-9a-f-]{36}$/.test(id ?? "")) throw new Error("Unauthorized listener.");
    const row = await this.repository.getSession(id); const hash = digest(token);
    if (!row || row.revokedAt || Date.parse(row.expiresAt) <= this.now() || hash.length !== row.tokenHash.length || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(hash))) throw new Error("Unauthorized listener.");
    return row;
  }
}
