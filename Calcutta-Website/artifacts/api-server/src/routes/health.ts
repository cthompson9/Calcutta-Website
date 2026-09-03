import { Router, type IRouter } from "express";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  sendParsedJson(res, HealthCheckResponse, data);
});

export default router;
