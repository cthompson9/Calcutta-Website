import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { normalize, priceCents } from "./interpreter.mjs";

const match = (text, rows) => {
  const matches = rows.filter((r) =>
    [r.displayName, ...(r.aliases ?? [])].some(
      (n) => normalize(n) === normalize(text),
    ),
  );
  return matches.length === 1 ? matches[0] : null;
};

export function validateDraft(draft, context) {
  const issues = {};
  const lot = context?.lots.find((l) => l.id === draft.lotId);
  if (
    !lot ||
    lot.status !== "bidding" ||
    lot.nominationId !== draft.nominationId ||
    context.currentLotId !== lot.id
  )
    issues.lot =
      "The active nomination changed. Review the lot before submitting.";
  if (
    !Number.isSafeInteger(draft.totalCents) ||
    draft.totalCents <= 0 ||
    draft.totalCents > 100000000
  )
    issues.amount = "Enter a final amount between $0.01 and $1,000,000.";
  const owners = Array.isArray(draft.allocations) ? draft.allocations : [];
  if (
    !owners.length ||
    owners.length > 8 ||
    owners.some(
      (a) =>
        !context?.consortia.some(
          (c) => c.id === a.consortiumId && c.active === 1,
        ),
    ) ||
    new Set(owners.map((a) => a.consortiumId)).size !== owners.length
  )
    issues.owners = "Choose distinct, active consortia from the website.";
  if (
    !owners.length ||
    owners.some(
      (a) => !Number.isInteger(a.basisPoints) || a.basisPoints <= 0,
    ) ||
    owners.reduce((n, a) => n + (a.basisPoints ?? 0), 0) !== 10000
  )
    issues.shares = "Ownership percentages must total exactly 100%.";
  return issues;
}

export function parseResult(text, context, binding) {
  const raw = text.trim().replace(/[.!?]+$/, "");
  if (!/\bsold\b/i.test(raw)) return null;
  const issues = {};
  if (
    /\b(?:not sold|unsold|don't|do not|correction|actually|cancel|wait|hold on|maybe|if|example|would|could)\b/i.test(
      raw,
    )
  )
    issues.announcement =
      "Possible correction or conditional announcement. Review before submitting.";
  const sale = /^(?:(.+?)\s+)?sold\s+to\s+(.+?)(?:\s+for\s+(.+))?$/i.exec(
    raw
      .replace(
        /^(?:going\s+)?once[, .]*\s*(?:(?:going\s+)?twice[, .]*\s*)?/i,
        "",
      )
      .replace(/^twice[, .]*\s*/i, ""),
  );
  const lot = context?.lots.find((l) => l.id === binding?.lotId);
  if (!binding?.safe)
    issues.lot =
      "Speech timing does not identify one current nomination. Select and confirm the lot.";
  if (sale?.[1] && match(sale[1], context?.lots ?? [])?.id !== lot?.id)
    issues.lot = "The spoken lot differs from the nominated lot. Review it.";
  const roster = context?.consortia.filter((c) => c.active === 1) ?? [];
  let owners = sale?.[2]?.replace(/[,;]+$/, "").trim() ?? "";
  const equal =
    /(?:,?\s+)(fifty[ -]fifty|50[ /-]50|equally|equal shares)$/i.exec(owners);
  if (equal) owners = owners.slice(0, equal.index).trim();
  const whole = match(owners, roster);
  const pieces = whole
    ? [owners]
    : owners.split(/\s+(?:and|&)\s+|\s*,\s*/).filter(Boolean);
  const allocations = pieces.map((part) => {
    const percent = /\s+(\d+(?:\.\d{1,2})?)\s*(?:%|percent)$/i.exec(part);
    const name = percent ? part.slice(0, percent.index).trim() : part;
    const consortium = match(name, roster);
    return {
      consortiumId: consortium?.id ?? null,
      heardName: name,
      basisPoints: percent ? Math.round(Number(percent[1]) * 100) : null,
    };
  });
  if (
    equal &&
    allocations.length &&
    !allocations.some((a) => a.basisPoints !== null)
  ) {
    if (/fifty|50/i.test(equal[1]) && allocations.length !== 2)
      issues.shares = "Fifty-fifty requires two winners.";
    else
      allocations.forEach((a, i) => {
        a.basisPoints =
          Math.floor(10000 / allocations.length) +
          (i < 10000 % allocations.length ? 1 : 0);
      });
  } else if (allocations.length === 1 && allocations[0].basisPoints === null)
    allocations[0].basisPoints = 10000;
  const draft = {
    lotId: lot?.id ?? null,
    nominationId: binding?.nominationId ?? null,
    totalCents: sale?.[3] ? priceCents(sale[3]) : null,
    allocations,
  };
  if (!sale)
    issues.announcement =
      "Waiting for a complete “sold to [winner] for [amount]” announcement.";
  return { ...draft, issues: { ...validateDraft(draft, context), ...issues } };
}

export class LiveAuction {
  constructor({ file, bridge, now = Date.now }) {
    Object.assign(this, { file, bridge, now });
    this.data = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { sessionId: null, drafts: [], transcript: [], seen: [] };
    this.context = null;
    this.history = [];
    this.lastSync = 0;
    this.syncing = false;
    this.sending = false;
    this.error = "";
    this.pending = null;
    this.switching = false;
  }
  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), {
      mode: 0o600,
    });
    renameSync(`${this.file}.tmp`, this.file);
  }
  hasUnresolved() {
    return this.data.drafts.some(
      (d) => d.status !== "submitted" && d.status !== "dismissed",
    );
  }
  ready() {
    return (
      !this.switching &&
      !!this.context &&
      this.lastSync > 0 &&
      this.now() - this.lastSync < 6000 &&
      this.bridge.status().connected
    );
  }
  snapshot() {
    return {
      context: this.context,
      drafts: this.data.drafts,
      transcript: this.data.transcript,
      ready: this.ready(),
      error: this.error,
      pending: this.data.drafts.filter((d) => d.status === "pending").length,
      auctionKey: this.data.auctionKey ?? null,
    };
  }
  async sync() {
    if (this.switching || this.syncing || !this.bridge.data.pairing) return;
    this.syncing = true;
    try {
      const sessionId = this.bridge.data.pairing.id;
      const context = await this.bridge.context();
      if (
        context.protocolVersion !== 2 ||
        !Array.isArray(context.lots) ||
        !Array.isArray(context.consortia) ||
        !Array.isArray(context.sales)
      )
        throw new Error(
          "Website needs the listener result update before recording.",
        );
      const pairing = this.bridge.data.pairing;
      if (!Number.isSafeInteger(context.id) || context.id <= 0 ||
          String(context.id) !== String(pairing.auction?.id) || !pairing.origin)
        throw new Error("Website returned a different auction. Reconnect from its Auction tab.");
      // Origin isolates separate installations even when their database IDs overlap.
      const auctionKey = createHash("sha256").update(JSON.stringify([pairing.origin, context.id])).digest("hex");
      const changed = this.data.auctionKey !== auctionKey;
      const legacySameSession = !this.data.auctionKey && this.data.sessionId === sessionId;
      if (changed || this.data.sessionId !== sessionId) {
        if (this.hasUnresolved() && !legacySameSession)
          throw new Error("Resolve the previous auction results before switching auctions.");
        if (changed && !legacySameSession) {
          if (this.data.auctionKey) this.archive();
          else if (this.data.sessionId) {
            // Never guess which auction owns a legacy session file.
            const legacyKey = createHash("sha256").update(this.data.sessionId).digest("hex");
            writeFileSync(`${this.file}.${legacyKey}.archive.json`, JSON.stringify(this.data), {mode: 0o600});
          }
          const saved = `${this.file}.${auctionKey}.auction.json`;
          this.data = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) :
            { drafts: [], transcript: [], seen: [] };
          if (this.data.auctionKey && this.data.auctionKey !== auctionKey)
            throw new Error("Saved auction identity does not match.");
        }
        Object.assign(this.data, {sessionId, auctionKey});
        this.history = [];
        this.context = null;
        this.pending = null;
        this.lastSync = 0;
        this.save();
      }
      const lot = context.lots.find(
        (l) => l.id === context.currentLotId && l.status === "bidding",
      );
      const nominationId = lot?.nominationId ?? null;
      if (
        !this.history.length ||
        this.history.at(-1).nominationId !== nominationId ||
        this.now() - this.lastSync >= 6000
      ) {
        this.history.push({
          at: this.now(),
          lotId: lot?.id ?? null,
          nominationId,
        });
        this.history = this.history.slice(-500);
      }
      this.context = context;
      this.lastSync = this.now();
      this.error = "";
    } catch (error) {
      this.lastSync = 0;
      this.error = error.message;
    } finally {
      this.syncing = false;
    }
  }
  archive() {
    const target = `${this.file}.${this.data.auctionKey}.auction.json`;
    writeFileSync(`${target}.tmp`, JSON.stringify(this.data), {mode: 0o600});
    renameSync(`${target}.tmp`, target);
  }
  ingest(input) {
    if (this.switching) throw new Error("Wait for the auction connection to finish.");
    if (input.websiteSessionId !== this.data.sessionId)
      throw new Error("Transcript belongs to another auction.");
    const event = input.event;
    if (!["transcript.data", "transcript.partial_data"].includes(event?.event))
      throw new Error("Invalid transcript type.");
    const words = event.data?.data?.words;
    if (!Array.isArray(words) || words.length > 5000)
      throw new Error("Invalid transcript.");
    const text = words
      .map((w) => (typeof w === "string" ? w : (w.text ?? "")))
      .join(" ")
      .trim();
    if (!text || text.length > 20000) return;
    const speaker = String(
      event.data.data.participant?.id ??
        event.data.data.participant ??
        "unknown",
    );
    const start = words[0]?.start_timestamp?.relative;
    const end = words.at(-1)?.end_timestamp?.relative ?? start;
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          input.uploadId,
          speaker,
          event.event,
          start,
          end,
          text,
        ]),
      )
      .digest("hex");
    if (this.data.seen.includes(key)) return;
    this.data.seen.push(key);
    const final = event.event === "transcript.data";
    this.data.transcript = [
      { id: key, text, final },
      ...this.data.transcript.filter((t) => t.final),
    ].slice(0, 100);
    if (final) {
      const spokenAt =
        Number.isFinite(start) && Number.isFinite(input.captureStartedAt)
          ? input.captureStartedAt + start * 1000
          : null;
      const observed =
        spokenAt === null
          ? null
          : this.history.findLast((h) => h.at <= spokenAt);
      const current = this.history.at(-1);
      const binding = {
        ...observed,
        safe:
          this.ready() &&
          !!observed?.nominationId &&
          observed === current &&
          spokenAt >= observed.at + 2000 &&
          spokenAt <= this.now() &&
          start >= 0 &&
          end >= start,
      };
      const stream = `${input.uploadId}:${speaker}`;
      const previous =
        this.pending &&
        this.pending.stream === stream &&
        this.now() - this.pending.at < 8000 &&
        !/\bsold\b/i.test(text)
          ? this.pending
          : null;
      const combined = previous ? `${previous.text} ${text}` : text;
      const parsed = parseResult(
        combined,
        this.context,
        previous?.binding ?? binding,
      );
      if (parsed) {
        let draft =
          previous &&
          this.data.drafts.find(
            (d) => d.id === previous.id && d.status === "review" && !d.manual,
          );
        if (!draft) {
          draft = { id: randomUUID(), status: "review", revision: 0 };
          this.data.drafts.push(draft);
        }
        Object.assign(draft, parsed, {
          text: combined,
          revision: draft.revision + 1,
        });
        if (
          this.data.drafts.some(
            (d) =>
              d.id !== draft.id &&
              d.nominationId &&
              d.nominationId === draft.nominationId &&
              d.status !== "dismissed",
          )
        )
          draft.issues.announcement =
            "Another result exists for this nomination. Review in the website before submitting.";
        if (!Object.keys(draft.issues).length) draft.status = "pending";
        this.pending =
          draft.status === "review"
            ? {
                id: draft.id,
                text: combined,
                stream,
                binding: previous?.binding ?? binding,
                at: this.now(),
              }
            : null;
      }
    }
    this.save();
  }
  correct({ id, expectedRevision, lotId, totalCents, allocations }) {
    if (!this.ready())
      throw new Error("Reconnect and refresh the auction before submitting.");
    const draft = this.data.drafts.find((d) => d.id === id);
    if (id && !draft)
      throw new Error("This review no longer exists. Refresh the results.");
    if (
      draft &&
      (draft.status !== "review" || draft.revision !== expectedRevision)
    )
      throw new Error(
        "This result changed or is already awaiting acknowledgment. Refresh it first.",
      );
    const lot = this.context.lots.find((l) => l.id === lotId);
    const clean = {
      lotId,
      nominationId: lot?.nominationId,
      totalCents,
      allocations,
    };
    const issues = validateDraft(clean, this.context);
    if (Object.keys(issues).length)
      throw new Error(Object.values(issues).join(" "));
    const next = draft ?? {
      id: randomUUID(),
      revision: 0,
      text: "Manual result",
    };
    // A changed submission is a new operation; an uncertain pending operation cannot be edited.
    Object.assign(next, clean, {
      status: "pending",
      issues: {},
      manual: true,
      revision: next.revision + 1,
      requestId: randomUUID(),
    });
    if (!draft) this.data.drafts.push(next);
    this.pending = null;
    this.save();
    return next;
  }
  beginReview({ id, expectedRevision, lotId }) {
    let draft = this.data.drafts.find((d) => d.id === id);
    if (
      id &&
      (!draft ||
        draft.status !== "review" ||
        draft.revision !== expectedRevision)
    )
      throw new Error("This result changed. Refresh before editing.");
    if (!draft) {
      if (
        this.data.drafts.some(
          (d) =>
            d.lotId === lotId && !["dismissed", "submitted"].includes(d.status),
        )
      )
        throw new Error(
          "A result already exists for this lot. Edit that review.",
        );
      const lot = this.context?.lots.find(
        (l) => l.id === lotId && l.status === "bidding",
      );
      if (!this.ready() || !lot)
        throw new Error("Refresh the nominated lot before editing.");
      draft = {
        id: randomUUID(),
        lotId,
        nominationId: lot.nominationId,
        allocations: [],
        totalCents: null,
        text: "Manual review",
        status: "review",
        revision: 0,
        issues: { announcement: "Commissioner is reviewing this result." },
      };
      this.data.drafts.push(draft);
    }
    draft.manual = true;
    draft.revision++;
    this.pending = null;
    this.save();
    return structuredClone(draft);
  }
  dismiss(id) {
    const draft = this.data.drafts.find((d) => d.id === id);
    if (!draft || draft.status !== "review")
      throw new Error("Only an unsent review can be dismissed.");
    draft.status = "dismissed";
    draft.revision++;
    this.save();
  }
  async flush() {
    if (
      this.sending ||
      this.switching ||
      !this.bridge.data.pairing ||
      this.data.sessionId !== this.bridge.data.pairing.id
    )
      return;
    this.sending = true;
    try {
      for (const draft of this.data.drafts.filter(
        (d) => d.status === "pending",
      )) {
        draft.requestId ??= randomUUID();
        this.save();
        try {
          const ack = await this.bridge.submitResult({
            idempotencyKey: draft.requestId,
            lotId: draft.lotId,
            nominationId: draft.nominationId,
            totalCents: draft.totalCents,
            allocations: draft.allocations.map(
              ({ consortiumId, basisPoints }) => ({
                consortiumId,
                basisPoints,
              }),
            ),
          });
          if (
            ack.idempotencyKey !== draft.requestId ||
            !Number.isInteger(ack.saleId)
          )
            throw new Error("Website has not acknowledged saving this result.");
          draft.status = "submitted";
          draft.saleId = ack.saleId;
          draft.message = "Saved on website";
          draft.revision++;
          this.save();
        } catch (error) {
          draft.message = error.message;
          if ([409, 422].includes(error.status)) {
            draft.status = "review";
            draft.issues = { submission: error.message };
            draft.revision++;
          }
          this.save();
          break;
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
