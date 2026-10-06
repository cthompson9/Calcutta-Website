import { Router, type IRouter } from "express";
import { GetMlbResultsResponse } from "@workspace/api-zod";
import { sendParsedJson } from "../lib/sendParsedJson";
import { getMlbResults } from "../lib/mlbResults";
import { loadMlbPool, refreshMlbResults } from "../lib/mlbRefresh";
import { requireAdmin } from "../middlewares/requireAdmin";

function poolId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
export function createMlbResultsRouter(deps: {
  read?: typeof getMlbResults; loadPool?: typeof loadMlbPool; refresh?: typeof refreshMlbResults;
} = {}): IRouter {
const router: IRouter = Router();
const read = deps.read ?? getMlbResults;
const loadPool = deps.loadPool ?? loadMlbPool;
const refresh = deps.refresh ?? refreshMlbResults;
router.get("/calcuttas/:calcuttaId/mlb-results", async (req, res) => {
  const id = poolId(req.params.calcuttaId);
  if (id == null) { res.status(400).json({ error: "A positive integer calcuttaId is required." }); return; }
  const report = await read(id);
  if (!report) { res.status(404).json({ error: "MLB postseason pool not found." }); return; }
  sendParsedJson(res, GetMlbResultsResponse, report);
});
router.post("/calcuttas/:calcuttaId/mlb-results/refresh", requireAdmin, async (req, res) => {
  const id = poolId(req.params.calcuttaId);
  const pool = id == null ? null : await loadPool(id);
  if (!pool) { res.status(404).json({ error: "MLB postseason pool not found." }); return; }
  const result = await refresh(pool, { force: true });
  if (!result.ran && !["already-running"].includes(result.reason)) {
    res.status(503).json({ error: result.reason }); return;
  }
  sendParsedJson(res, GetMlbResultsResponse, await read(pool.id));
});
return router;
}
export default createMlbResultsRouter();
