import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { createMcpRouter } from "./mcpServer";
import { createMcpOAuthRouter } from "./mcpOAuth";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth discovery and authorization must be reachable before an MCP client can
// obtain a bearer token for the protected endpoint below.
app.use(createMcpOAuthRouter());

// MCP server — mounted at /api/mcp so Replit's proxy routes it correctly
app.use("/api/mcp", createMcpRouter());

app.use("/api", router);

export default app;
