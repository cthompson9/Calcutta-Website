import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ListenerTickets, digest } from "../hosted/tickets.mjs";

const origin = "https://thecalcutta.app";
const auction = { id: 7, name: "Test auction", status: "live" };

function fixture({ open = true } = {}) {
  const tickets = new Map();
  const sessions = new Map();
  let now = 1_000_000;
  let queue = Promise.resolve();
  const repository = {
    async createTicket(row) { tickets.set(row.hash, { ...row }); },
    async getSession(id) { return sessions.get(id); },
    // This deliberately models the row lock required by the production
    // adapter. No database or shared development data is touched.
    async withTicket(hash, callback) {
      const run = queue.then(async () => callback({
        getTicket: async () => tickets.get(hash),
        getOpenAuction: async () => open ? auction : null,
        getSession: async (id) => sessions.get(id),
        activateSession: async (session) => {
          const current = [...sessions.values()].filter((x) => x.auctionId === session.auctionId && !x.revokedAt);
          if (current.some((x) => x.recording || x.pending > 0)) {
            throw new Error("An active listener is recording or has pending deliveries.");
          }
          for (const row of current) row.revokedAt = new Date(now);
          sessions.set(session.id, { ...session, recording: false, pending: 0 });
        },
        markRedeemed: async ({ redemptionId, sessionId }) => {
          const row = tickets.get(hash);
          Object.assign(row, { redemptionId, sessionId });
        },
      }));
      queue = run.catch(() => {});
      return run;
    },
  };
  return {
    service: new ListenerTickets({ repository, secret: "s".repeat(32), now: () => now }),
    tickets, sessions, setNow(value) { now = value; }, setOpen(value) { open = value; },
  };
}

async function issued(service) {
  const result = await service.issue(auction.id, origin);
  const params = new URLSearchParams(new URL(result.launchUrl).hash.slice(1));
  return { ticket: params.get("ticket"), origin, redemptionId: randomUUID() };
}

test("transactional redemption permits one winner under concurrent retries", async () => {
  const f = fixture();
  const request = await issued(f.service);
  const [first, second] = await Promise.allSettled([
    f.service.redeem(request),
    f.service.redeem({ ...request, redemptionId: randomUUID() }),
  ]);
  assert.equal([first, second].filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(f.sessions.size, 1);
  const retry = await f.service.redeem(request);
  assert.equal(retry.id, first.status === "fulfilled" ? first.value.id : second.value.id);
});

test("idle session replacement revokes the old session atomically", async () => {
  const f = fixture();
  const first = await issued(f.service);
  const paired = await f.service.redeem(first);
  const next = await issued(f.service);
  const replacement = await f.service.redeem(next);
  assert.notEqual(replacement.id, paired.id);
  assert.equal(f.sessions.get(paired.id).revokedAt instanceof Date, true);
  await assert.rejects(f.service.authenticate(paired.id, paired.token), /Unauthorized/);
  assert.equal((await f.service.authenticate(replacement.id, replacement.token)).auctionId, auction.id);
});

test("recording or pending old session blocks replacement", async () => {
  const f = fixture();
  const first = await issued(f.service);
  const paired = await f.service.redeem(first);
  f.sessions.get(paired.id).recording = true;
  await assert.rejects(f.service.redeem(await issued(f.service)), /recording|pending deliveries/);
  f.sessions.get(paired.id).recording = false;
  f.sessions.get(paired.id).pending = 1;
  await assert.rejects(f.service.redeem(await issued(f.service)), /recording|pending deliveries/);
});

test("wrong origin, completed auction, expiry, and revoked token fail closed", async () => {
  const f = fixture();
  const request = await issued(f.service);
  await assert.rejects(f.service.redeem({ ...request, origin: "https://evil.example" }), /expired/);
  f.setOpen(false);
  await assert.rejects(f.service.redeem(request), /complete/);
  f.setOpen(true);
  f.setNow(1_100_001);
  await assert.rejects(f.service.redeem(request), /expired/);
  f.setNow(1_000_000);
  const fresh = await f.service.redeem(await issued(f.service));
  f.sessions.get(fresh.id).revokedAt = new Date();
  await assert.rejects(f.service.authenticate(fresh.id, fresh.token), /Unauthorized/);
  assert.equal(digest("ticket").length, 64);
});