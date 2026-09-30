import Fastify from "fastify";
import { config } from "./config";
import { allProviders } from "./providers/registry";
import { usdc } from "./stellar/network";

/**
 * Initial server: health and provider capabilities. The ramp session API
 * (sessions, webhooks, reconciler) is specified in the README and built on
 * the modules under src/.
 */
export function buildServer() {
  const app = Fastify({ logger: config().NODE_ENV !== "test" });

  app.get("/health", async () => ({ status: "ok", network: config().STELLAR_NETWORK }));

  app.get("/v1/providers", async () => ({
    network: config().STELLAR_NETWORK,
    usdc: usdc(),
    providers: allProviders().map((p) => p.capabilities()),
  }));

  return app;
}

if (require.main === module) {
  const cfg = config();
  buildServer()
    .listen({ port: cfg.PORT, host: "0.0.0.0" })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
