import { z } from "zod";

/** Canonical URL for the AuctionPro draft-order endpoint (public, no auth). */
export const DRAFT_ORDER_SOURCE_URL =
  process.env["DRAFT_ORDER_SOURCE_URL"] ??
  "https://nfl-calcutta-bid-helper.replit.app/api/draft-order";

// ── Abbreviation lookup ───────────────────────────────────────────────────────
// Maps the abbreviations AuctionPro emits to the full team names we store.
// Covers both AuctionPro variants (e.g. JAX) and alternate common forms.
const TEAM_NAME_BY_ABBREV: Record<string, string> = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB:  "Green Bay Packers",
  GNB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",  // AuctionPro
  JAC: "Jacksonville Jaguars",  // Kalshi
  KC:  "Kansas City Chiefs",
  KAN: "Kansas City Chiefs",
  LV:  "Las Vegas Raiders",
  OAK: "Las Vegas Raiders",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  LA:  "Los Angeles Rams",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE:  "New England Patriots",
  NWE: "New England Patriots",
  NO:  "New Orleans Saints",
  NOR: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SF:  "San Francisco 49ers",
  SFO: "San Francisco 49ers",
  SEA: "Seattle Seahawks",
  TB:  "Tampa Bay Buccaneers",
  TAM: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WAS: "Washington Commanders",
  WSH: "Washington Commanders",
};

export function teamNameFromAbbrev(abbrev: string): string | null {
  return TEAM_NAME_BY_ABBREV[abbrev.toUpperCase()] ?? null;
}

// ── Response schema ───────────────────────────────────────────────────────────

const entrySchema = z.object({
  draftOrder: z.number().int().positive().nullable(),
  team:       z.string().trim().min(1),
  owner:      z.string().trim().min(1),
  value:      z.number().finite().positive(),
  orderStatus: z.string().optional(),
});

const responseSchema = z.object({
  draftOrder: z.array(entrySchema).min(1),
  soldCount:  z.number().int(),
  error:      z.string().nullable().optional(),
});

export type DraftOrderEntry = z.infer<typeof entrySchema>;

export class DraftOrderImportError extends Error {
  constructor(message: string, public readonly statusCode = 502) {
    super(message);
    this.name = "DraftOrderImportError";
  }
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseDraftOrderPayload(payload: unknown): DraftOrderEntry[] {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DraftOrderImportError(
      "AuctionPro draft-order endpoint returned an unexpected shape: " +
        parsed.error.issues[0]?.message,
      422,
    );
  }

  if (parsed.data.error) {
    throw new DraftOrderImportError(
      `AuctionPro draft-order endpoint reported an error: ${parsed.data.error}`,
      502,
    );
  }

  if (parsed.data.soldCount !== 32) {
    throw new DraftOrderImportError(
      `AuctionPro draft-order reports soldCount=${parsed.data.soldCount}. All 32 teams must be sold before importing.`,
      422,
    );
  }

  if (parsed.data.draftOrder.length !== 32) {
    throw new DraftOrderImportError(
      `AuctionPro draft-order returned ${parsed.data.draftOrder.length} entries — expected exactly 32.`,
      422,
    );
  }

  const abbrevs = new Set<string>();
  for (const entry of parsed.data.draftOrder) {
    const key = entry.team.toUpperCase();
    if (abbrevs.has(key)) {
      throw new DraftOrderImportError(
        `AuctionPro draft-order lists team "${entry.team}" more than once.`,
        422,
      );
    }
    abbrevs.add(key);
    if (!TEAM_NAME_BY_ABBREV[key]) {
      throw new DraftOrderImportError(
        `Unknown team abbreviation "${entry.team}" in AuctionPro draft-order. Update TEAM_NAME_BY_ABBREV in draftOrderImport.ts.`,
        422,
      );
    }
  }

  return parsed.data.draftOrder;
}

// ── Fetcher ───────────────────────────────────────────────────────────────────

export async function fetchDraftOrderPayload(): Promise<DraftOrderEntry[]> {
  let url: URL;
  try {
    url = new URL(DRAFT_ORDER_SOURCE_URL);
  } catch {
    throw new DraftOrderImportError("DRAFT_ORDER_SOURCE_URL is invalid.", 503);
  }
  if (url.protocol !== "https:") {
    throw new DraftOrderImportError("DRAFT_ORDER_SOURCE_URL must use HTTPS.", 503);
  }

  // Optional server-side bearer credential — set DRAFT_ORDER_SOURCE_AUTHORIZATION
  // to the raw token value (without "Bearer " prefix) to bypass Replit deployment
  // protection or any other bearer-auth gate on the source endpoint.
  const sourceToken = process.env["DRAFT_ORDER_SOURCE_AUTHORIZATION"];
  const headers: Record<string, string> = { accept: "application/json" };
  if (sourceToken) headers.authorization = `Bearer ${sourceToken}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DraftOrderImportError(
      "Could not reach the AuctionPro draft-order endpoint. Check network access and the source URL.",
    );
  }

  if (!response.ok) {
    throw new DraftOrderImportError(
      `AuctionPro draft-order endpoint returned HTTP ${response.status}. ` +
        (response.status === 401 || response.status === 403
          ? "Set DRAFT_ORDER_SOURCE_AUTHORIZATION to a valid bearer token."
          : "Check the source URL and server availability."),
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    throw new DraftOrderImportError(
      "AuctionPro draft-order endpoint returned a web page instead of JSON. " +
        "If the site has Replit deployment protection enabled, set DRAFT_ORDER_SOURCE_AUTHORIZATION " +
        "to a bearer token that bypasses it (e.g. an X-Replit-Auth-Token or custom secret).",
      422,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DraftOrderImportError("AuctionPro draft-order endpoint returned invalid JSON.", 422);
  }

  return parseDraftOrderPayload(payload);
}
