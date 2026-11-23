import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { resetConfig } from "../src/config";

const SECRET = "c".repeat(40);

describe("POST /internal/reconcile", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.CRON_SECRET = SECRET;
    resetConfig();
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.CRON_SECRET;
    resetConfig();
  });

  const call = (authorization?: string) =>
    app.inject({ method: "POST", url: "/internal/reconcile", headers: authorization ? { authorization } : {} });

  it("runs one worker pass with the secret", async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("looks like it doesn't exist without the right secret", async () => {
    expect((await call()).statusCode).toBe(404);
    expect((await call(`Bearer ${"d".repeat(40)}`)).statusCode).toBe(404);
    expect((await call("Bearer short")).statusCode).toBe(404);
  });
});
