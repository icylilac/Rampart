import type { IncomingMessage, ServerResponse } from "node:http";
import { buildServer } from "./app";

/**
 * The API as one Vercel function. scripts/vercel-build.sh bundles this file
 * (dependencies included) into dist-vercel/handler.js, api/index.js loads it,
 * and vercel.json rewrites every path there for Fastify to route as usual.
 * Only the HTTP API runs on Vercel; the reconciler and webhook delivery need
 * a long-running `npm run worker`.
 */
const app = buildServer();
const ready = app.ready();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await ready;
  app.server.emit("request", req, res);
}
