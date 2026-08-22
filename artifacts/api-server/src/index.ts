import app from "./app";
import { logger } from "./lib/logger";
import {
  closeDatabasePool,
  ensureOwnerPositionRollout,
} from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = await (async () => {
  try {
    await ensureOwnerPositionRollout();
  } catch (err) {
    logger.error({ err }, "Owner position rollout failed");
    process.exit(1);
  }
  return app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
})();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down API server");
  server.close(async (error) => {
    if (error) logger.error({ err: error }, "Error closing API server");
    try {
      await closeDatabasePool();
    } finally {
      process.exit(error ? 1 : 0);
    }
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
