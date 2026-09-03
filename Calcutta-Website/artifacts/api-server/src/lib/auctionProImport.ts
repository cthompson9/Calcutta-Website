import { z } from "zod";

export type AuctionProOwner = {
  name: string;
  share: number;
};

export type AuctionProTeam = {
  teamName: string;
  bidAmount: number;
  owners: AuctionProOwner[];
};

const ownerSchema = z.object({
  name: z.string().trim().min(1),
  share: z.coerce.number().finite().positive().max(1),
}).strict();

const teamSchema = z.object({
  teamName: z.string().trim().min(1),
  bidAmount: z.coerce.number().finite().positive(),
  owners: z.array(ownerSchema).min(1),
}).strict();

const sourceSchema = z.object({
  teams: z.array(teamSchema).length(32),
}).strict();

export class AuctionProImportError extends Error {
  constructor(message: string, public readonly statusCode = 502) {
    super(message);
    this.name = "AuctionProImportError";
  }
}

export function parseAuctionProPayload(payload: unknown): AuctionProTeam[] {
  const parsed = sourceSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AuctionProImportError(
      "AuctionPro export must be JSON in the form { teams: [{ teamName, bidAmount, owners: [{ name, share }] }] } with exactly 32 teams.",
      422,
    );
  }

  const names = new Set<string>();
  for (const team of parsed.data.teams) {
    const key = team.teamName.toLocaleLowerCase("en-US");
    if (names.has(key)) {
      throw new AuctionProImportError(`AuctionPro export includes ${team.teamName} more than once.`, 422);
    }
    names.add(key);
  }

  return parsed.data.teams;
}

/**
 * Fetches a server-configured JSON export. The source URL is deliberately an
 * environment value, not request input, to avoid turning this endpoint into an
 * SSRF proxy. Optional authorization is a server secret and is never returned.
 */
export async function fetchAuctionProPayload(): Promise<AuctionProTeam[]> {
  const sourceUrl = process.env["AUCTIONPRO_SOURCE_URL"];
  if (!sourceUrl) {
    throw new AuctionProImportError(
      "AuctionPro import is not configured. Set AUCTIONPRO_SOURCE_URL to a JSON export endpoint.",
      503,
    );
  }

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new AuctionProImportError("AuctionPro source URL is invalid.", 503);
  }
  if (url.protocol !== "https:") {
    throw new AuctionProImportError("AuctionPro source URL must use HTTPS.", 503);
  }

  const sourceAuthorization = process.env["AUCTIONPRO_SOURCE_AUTHORIZATION"];
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (sourceAuthorization) headers.authorization = sourceAuthorization;

  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new AuctionProImportError(
      "Could not reach the AuctionPro export. Check the configured source URL and its server credential.",
    );
  }

  if (!response.ok) {
    throw new AuctionProImportError(
      `AuctionPro export returned ${response.status}. Check source access and the configured server credential.`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    throw new AuctionProImportError(
      "AuctionPro returned a web page instead of JSON. Configure a public JSON export endpoint; Replit private-site login pages cannot be scraped server-side.",
      422,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AuctionProImportError("AuctionPro returned invalid JSON.", 422);
  }

  return parseAuctionProPayload(payload);
}