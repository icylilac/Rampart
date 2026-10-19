import { config } from "./config";
import { startWorker } from "./engine/reconciler";
import { db } from "./lib/db";

/**
 * Standalone worker: polls open sessions, expires abandoned ones, retries
 * on-chain verification, drives sandbox scenarios and delivers webhooks.
 * Several workers can run at once; webhook deliveries are claimed atomically.
 */
config();
const stop = startWorker();
console.log("[worker] running");

const shutdown = async () => {
  await stop();
  await db().$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
