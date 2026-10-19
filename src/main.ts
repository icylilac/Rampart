import { buildServer } from "./app";
import { config } from "./config";
import { startWorker } from "./engine/reconciler";

export { buildServer };

/**
 * API server. By default it also runs the reconciler and webhook delivery;
 * set WORKER_IN_PROCESS=false and run `npm run worker` to split them.
 */
if (require.main === module) {
  const cfg = config();
  const app = buildServer();
  const stopWorker = cfg.WORKER_IN_PROCESS ? startWorker() : null;

  const shutdown = async () => {
    await stopWorker?.();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  app.listen({ port: cfg.PORT, host: "0.0.0.0" }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
