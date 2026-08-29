import { Router, type IRouter, type Response } from "express";
import {
  GetHistoricalPoolsResponse,
  GetHistoricalOwnersResponse,
  GetHistoricalPoolEntriesResponse,
  GetHistoricalPoolOwnersResponse,
  GetHistoricalPoolTradesResponse,
} from "@workspace/api-zod";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import {
  loadNormalizedHistoricalEntries,
  loadNormalizedHistoricalOwnerResults,
  loadNormalizedHistoricalOwners,
  loadNormalizedHistoricalPools,
  loadNormalizedHistoricalTrades,
} from "../lib/normalizedHistoricalReports";

const router: IRouter = Router();

function parsePoolId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendInvalidPoolId(res: Response): void {
  sendParsedJson(res, ErrorResponse, { error: "Historical pool id must be a positive integer." }, 400);
}

router.get("/v2/pools", async (_req, res): Promise<void> => {
  sendParsedJson(res, GetHistoricalPoolsResponse, await loadNormalizedHistoricalPools());
});

router.get("/v2/owners", async (_req, res): Promise<void> => {
  sendParsedJson(
    res,
    GetHistoricalOwnersResponse,
    await loadNormalizedHistoricalOwnerResults(),
  );
});

router.get("/v2/pool/:id/entries", async (req, res): Promise<void> => {
  const poolId = parsePoolId(req.params.id);
  if (poolId == null) {
    sendInvalidPoolId(res);
    return;
  }
  const entries = await loadNormalizedHistoricalEntries(poolId);
  if (entries == null) {
    sendParsedJson(res, ErrorResponse, { error: "Historical pool not found." }, 404);
    return;
  }
  sendParsedJson(res, GetHistoricalPoolEntriesResponse, entries);
});

router.get("/v2/pool/:id/owners", async (req, res): Promise<void> => {
  const poolId = parsePoolId(req.params.id);
  if (poolId == null) {
    sendInvalidPoolId(res);
    return;
  }
  const owners = await loadNormalizedHistoricalOwners(poolId);
  if (owners == null) {
    sendParsedJson(res, ErrorResponse, { error: "Historical pool not found." }, 404);
    return;
  }
  sendParsedJson(res, GetHistoricalPoolOwnersResponse, owners);
});

router.get("/v2/pool/:id/trades", async (req, res): Promise<void> => {
  const poolId = parsePoolId(req.params.id);
  if (poolId == null) {
    sendInvalidPoolId(res);
    return;
  }
  const trades = await loadNormalizedHistoricalTrades(poolId);
  if (trades == null) {
    sendParsedJson(res, ErrorResponse, { error: "Historical pool not found." }, 404);
    return;
  }
  sendParsedJson(res, GetHistoricalPoolTradesResponse, trades);
});

export default router;