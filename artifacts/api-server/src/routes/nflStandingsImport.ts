import { Router, type IRouter, type Request } from "express";
import {
  ApplyNflStandingsImportBody,
  PreviewNflStandingsImportBody,
  ApplyNflStandingsImportResponse,
  PreviewNflStandingsImportResponse,
} from "@workspace/api-zod";
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
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "NFL standings import failed unexpectedly." });
}

router.post("/results/nfl-standings/preview", requireAdmin, async (req, res): Promise<void> => {
  const parsed = PreviewNflStandingsImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(PreviewNflStandingsImportResponse.parse(await previewNflStandingsImport(parsed.data.seasonYear)));
  } catch (error) {
    sendImportError(error, res);
  }
});

router.post("/results/nfl-standings/apply", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ApplyNflStandingsImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const requestId = req.headers["x-request-id"];
    res.json(ApplyNflStandingsImportResponse.parse(
      await applyNflStandingsImport({
        seasonYear: parsed.data.seasonYear,
        requestedBy: "admin_api",
        requestId: typeof requestId === "string" ? requestId : undefined,
      }),
    ));
  } catch (error) {
    sendImportError(error, res);
  }
});

export default router;