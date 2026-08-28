import { Router, type IRouter, type Request } from "express";
import {
  ApplyNflStandingsImportBody,
  PreviewNflStandingsImportBody,
  ApplyNflStandingsImportResponse,
  PreviewNflStandingsImportResponse,
} from "@workspace/api-zod";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import {
  applyNflStandingsImport,
  NflStandingsImportError,
  previewNflStandingsImport,
} from "../lib/nflStandingsImport";
import { requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();

function sendImportError(
  error: unknown,
  res: import("express").Response,
): void {
  if (error instanceof NflStandingsImportError) {
    sendParsedJson(res, ErrorResponse, { error: error.message }, error.statusCode);
    return;
  }
  sendParsedJson(res, ErrorResponse, { error: "NFL standings import failed unexpectedly." }, 500);
}

router.post("/results/nfl-standings/preview", requireAdmin, async (req, res): Promise<void> => {
  const parsed = PreviewNflStandingsImportBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  try {
    sendParsedJson(res, PreviewNflStandingsImportResponse, await previewNflStandingsImport(parsed.data.seasonYear));
  } catch (error) {
    sendImportError(error, res);
  }
});

router.post("/results/nfl-standings/apply", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ApplyNflStandingsImportBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }
  try {
    const requestId = req.headers["x-request-id"];
    sendParsedJson(res, ApplyNflStandingsImportResponse,
      await applyNflStandingsImport({
        seasonYear: parsed.data.seasonYear,
        requestedBy: "admin_api",
        requestId: typeof requestId === "string" ? requestId : undefined,
      }),
    );
  } catch (error) {
    sendImportError(error, res);
  }
});

export default router;