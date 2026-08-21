import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";
import {
  DraftOrderImportError,
  parseDraftOrderPayload,
  teamNameFromAbbrev,
  fetchDraftOrderPayload,
} from "./draftOrderImport.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALL_32_ABBREVS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB",  "HOU", "IND", "JAX", "KC",
  "LV",  "LAC", "LAR", "MIA", "MIN", "NE",  "NO",  "NYG",
  "NYJ", "PHI", "PIT", "SF",  "SEA", "TB",  "TEN", "WAS",
];

function makeEntry(abbrev, i) {
  return {
    draftOrder: i + 1,
    team: abbrev,
    owner: "Craig Thompson",
    value: 1000 + i * 100,
    orderStatus: "live-confirmed",
  };
}

function completePayload(overrides = {}) {
  return {
    draftOrder: ALL_32_ABBREVS.map((abbrev, i) => makeEntry(abbrev, i)),
    soldCount: 32,
    error: null,
    ...overrides,
  };
}

// ── teamNameFromAbbrev ────────────────────────────────────────────────────────

test("teamNameFromAbbrev resolves all 32 canonical AuctionPro abbreviations", () => {
  for (const abbrev of ALL_32_ABBREVS) {
    const name = teamNameFromAbbrev(abbrev);
    assert.ok(name, `Expected abbreviation "${abbrev}" to resolve to a team name`);
    assert.equal(typeof name, "string");
    assert.ok(name.length > 0);
  }
});

test("teamNameFromAbbrev handles alternate abbreviations (JAC, GNB, WSH)", () => {
  assert.equal(teamNameFromAbbrev("JAC"), "Jacksonville Jaguars");
  assert.equal(teamNameFromAbbrev("GNB"), "Green Bay Packers");
  assert.equal(teamNameFromAbbrev("WSH"), "Washington Commanders");
});

test("teamNameFromAbbrev returns null for unknown abbreviations", () => {
  assert.equal(teamNameFromAbbrev("XXX"), null);
  assert.equal(teamNameFromAbbrev(""), null);
  assert.equal(teamNameFromAbbrev("NFLTEAM"), null);
});

test("teamNameFromAbbrev is case-insensitive", () => {
  assert.equal(teamNameFromAbbrev("ne"), "New England Patriots");
  assert.equal(teamNameFromAbbrev("kc"), "Kansas City Chiefs");
});

// ── parseDraftOrderPayload ────────────────────────────────────────────────────

test("parseDraftOrderPayload accepts a valid 32-team payload", () => {
  const entries = parseDraftOrderPayload(completePayload());
  assert.equal(entries.length, 32);
  assert.equal(entries[0].team, "ARI");
  assert.equal(entries[0].draftOrder, 1);
  assert.equal(entries[0].value, 1000);
});

test("parseDraftOrderPayload accepts null draftOrder (unobserved teams)", () => {
  const payload = completePayload();
  payload.draftOrder[0].draftOrder = null;
  const entries = parseDraftOrderPayload(payload);
  assert.equal(entries[0].draftOrder, null);
});

test("parseDraftOrderPayload rejects when soldCount is not 32", () => {
  assert.throws(
    () => parseDraftOrderPayload(completePayload({ soldCount: 30 })),
    (error) => error instanceof DraftOrderImportError && error.statusCode === 422 &&
      /soldCount=30/i.test(error.message),
  );
});

test("parseDraftOrderPayload rejects when entry count is not 32", () => {
  const payload = completePayload();
  payload.draftOrder.pop(); // 31 entries
  assert.throws(
    () => parseDraftOrderPayload(payload),
    (error) => error instanceof DraftOrderImportError && error.statusCode === 422 &&
      /31 entries/i.test(error.message),
  );
});

test("parseDraftOrderPayload rejects duplicate team abbreviations", () => {
  const payload = completePayload();
  payload.draftOrder[31].team = payload.draftOrder[0].team; // duplicate ARI
  assert.throws(
    () => parseDraftOrderPayload(payload),
    (error) => error instanceof DraftOrderImportError && error.statusCode === 422 &&
      /more than once/i.test(error.message),
  );
});

test("parseDraftOrderPayload rejects unknown team abbreviations", () => {
  const payload = completePayload();
  payload.draftOrder[0].team = "ZZZ";
  assert.throws(
    () => parseDraftOrderPayload(payload),
    (error) => error instanceof DraftOrderImportError && error.statusCode === 422 &&
      /unknown team abbreviation/i.test(error.message),
  );
});

test("parseDraftOrderPayload rejects when the source reports an error", () => {
  const payload = completePayload({ error: "Auction still in progress" });
  assert.throws(
    () => parseDraftOrderPayload(payload),
    (error) => error instanceof DraftOrderImportError && error.statusCode === 502 &&
      /auction still in progress/i.test(error.message),
  );
});

test("parseDraftOrderPayload rejects malformed payload (missing required fields)", () => {
  assert.throws(
    () => parseDraftOrderPayload({ draftOrder: "not-an-array", soldCount: 32 }),
    (error) => error instanceof DraftOrderImportError && error.statusCode === 422,
  );
});

// ── fetchDraftOrderPayload — authorization header ─────────────────────────────

test("fetchDraftOrderPayload sends Authorization: Bearer <token> when env var is set", async () => {
  const capturedHeaders = [];

  const fakeFetch = mock.fn(async (url, init) => {
    capturedHeaders.push(init?.headers ?? {});
    // Return a well-formed JSON response
    return new Response(
      JSON.stringify(completePayload()),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  const savedEnv = process.env["DRAFT_ORDER_SOURCE_AUTHORIZATION"];
  process.env["DRAFT_ORDER_SOURCE_AUTHORIZATION"] = "mysecrettoken";
  process.env["DRAFT_ORDER_SOURCE_URL"] = "https://example.com/api/draft-order";

  try {
    await fetchDraftOrderPayload();
    assert.equal(capturedHeaders.length, 1, "fetch should have been called once");
    assert.equal(
      capturedHeaders[0].authorization,
      "Bearer mysecrettoken",
      "Authorization header must be Bearer-prefixed",
    );
  } finally {
    globalThis.fetch = saved;
    if (savedEnv === undefined) {
      delete process.env["DRAFT_ORDER_SOURCE_AUTHORIZATION"];
    } else {
      process.env["DRAFT_ORDER_SOURCE_AUTHORIZATION"] = savedEnv;
    }
    delete process.env["DRAFT_ORDER_SOURCE_URL"];
  }
});

test("fetchDraftOrderPayload omits Authorization header when env var is not set", async () => {
  const capturedHeaders = [];

  const fakeFetch = mock.fn(async (url, init) => {
    capturedHeaders.push(init?.headers ?? {});
    return new Response(
      JSON.stringify(completePayload()),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  const savedEnv = process.env["DRAFT_ORDER_SOURCE_AUTHORIZATION"];
  delete process.env["DRAFT_ORDER_SOURCE_AUTHORIZATION"];
  process.env["DRAFT_ORDER_SOURCE_URL"] = "https://example.com/api/draft-order";

  try {
    await fetchDraftOrderPayload();
    assert.equal(capturedHeaders.length, 1);
    assert.equal(capturedHeaders[0].authorization, undefined);
  } finally {
    globalThis.fetch = saved;
    if (savedEnv !== undefined) {
      process.env["DRAFT_ORDER_SOURCE_AUTHORIZATION"] = savedEnv;
    }
    delete process.env["DRAFT_ORDER_SOURCE_URL"];
  }
});

test("fetchDraftOrderPayload throws DraftOrderImportError when endpoint returns HTML", async () => {
  const fakeFetch = mock.fn(async () => {
    return new Response("<html>Login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });

  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  process.env["DRAFT_ORDER_SOURCE_URL"] = "https://example.com/api/draft-order";

  try {
    await assert.rejects(
      () => fetchDraftOrderPayload(),
      (error) => error instanceof DraftOrderImportError && error.statusCode === 422 &&
        /web page instead of JSON/i.test(error.message),
    );
  } finally {
    globalThis.fetch = saved;
    delete process.env["DRAFT_ORDER_SOURCE_URL"];
  }
});
