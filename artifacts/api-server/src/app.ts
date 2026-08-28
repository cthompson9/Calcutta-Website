import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import router from "./routes";
import { createMcpRouter } from "./mcpServer";
import { createMcpOAuthRouter } from "./mcpOAuth";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const localDevelopmentOrigins = new Set(["http://localhost:5173"]);
const configuredOrigins = [
  process.env["REPLIT_DEV_DOMAIN"],
  ...(process.env["REPLIT_DOMAINS"] ?? "").split(","),
  ...(process.env["CORS_ALLOWED_ORIGINS"] ?? "").split(","),
].filter((origin): origin is string => Boolean(origin)).map((origin) => origin.trim()).filter(Boolean).map((origin) =>
  origin.startsWith("http") ? origin : `https://${origin}`,
);
const allowedOrigins = new Set([...localDevelopmentOrigins, ...configuredOrigins]);
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

app.use(
  pinoHttp({
    logger,
    genReqId(req, res) {
      const supplied = req.headers["x-request-id"];
      const requestId = typeof supplied === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(supplied)
        ? supplied
        : randomUUID();
      res.setHeader("x-request-id", requestId);
      return requestId;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(helmet());
app.use(globalLimiter);
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed by CORS"));
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth discovery and authorization must be reachable before an MCP client can
// obtain a bearer token for the protected endpoint below.
app.use("/api/mcp/oauth", sensitiveLimiter);
app.use("/api/mcp/oauth/register", rateLimit({
  windowMs: 24 * 60 * 60 * 1_000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
}));
app.use(createMcpOAuthRouter());

// MCP server — mounted at /api/mcp so Replit's proxy routes it correctly
app.use("/api/mcp", createMcpRouter());

app.use("/api/admin/validate", sensitiveLimiter);
app.use("/api/jobs/refresh", sensitiveLimiter);
app.use("/api", router);

export const apiErrorHandler: express.ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = req.id;
  (req.log ?? logger).error({ err: error, requestId }, "Unhandled API error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal error", requestId });
};

app.use(apiErrorHandler);

export default app;
