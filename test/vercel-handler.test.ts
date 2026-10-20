import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import handler from "../src/vercel";

// The function Vercel runs (api/index.js loads this, bundled): the whole API behind one handler.
describe("Vercel entry point", () => {
  it("serves the API, including browser CORS preflights", async () => {
    const server = createServer(handler).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });

      const preflight = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      server.close();
    }
  });
});
