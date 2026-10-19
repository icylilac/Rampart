import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { resetConfig } from "../src/config";
import { encrypt } from "../src/lib/crypto";
import { db } from "../src/lib/db";
import { newApiKey } from "../src/lib/keys";

describe("hardening", () => {
  let app: FastifyInstance;
  let testKey: string;
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "8";
    resetConfig();
    app = buildServer();
    await app.ready();
    const test = newApiKey("TEST");
    testKey = test.key;
    await db().project.create({
      data: {
        name: "Security project",
        webhookSecretEnc: encrypt("whsec_security"),
        apiKeys: { create: [{ mode: "TEST", keyHash: test.hash, prefix: test.prefix }] },
      },
    });
  });

  afterAll(async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "0";
    resetConfig();
    await app.close();
  });

  it("rate-limits per key, separately from other callers, but never health checks", async () => {
    const other = { authorization: "Bearer rk_test_someone_else" };
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await app.inject({ url: "/v1/providers", headers: auth("rk_test_limit_a") })).statusCode);
    expect(codes).toEqual([...Array(8).fill(200), 429]);
    const limited = await app.inject({ url: "/v1/providers", headers: auth("rk_test_limit_a") });
    expect(limited.json()).toEqual({ error: { code: "rate_limited", message: "Too many requests. Try again shortly." } });
    expect((await app.inject({ url: "/v1/providers", headers: other })).statusCode).toBe(200);
    for (let i = 0; i < 12; i++) expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("sends security headers, and a strict CSP on the sandbox page", async () => {
    const res = await app.inject({ url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    const page = await app.inject({ url: "/sandbox/checkout/7d9f8e2a-1111-4c5e-9a1b-2b3c4d5e6f70" });
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.body).not.toContain("<script");
  });

  it("only accepts https return URLs (http for localhost)", async () => {
    const body = (redirect_url: string) => ({
      direction: "ON",
      wallet_address: Keypair.random().publicKey(),
      fiat_amount: 10,
      redirect_url,
    });
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "http://evil.example/return", "ftp://x.example/"]) {
      const res = await app.inject({ method: "POST", url: "/v1/sessions", headers: auth(testKey), payload: body(bad) });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
    for (const ok of ["https://app.example/return", "http://localhost:3000/return"]) {
      const res = await app.inject({ method: "POST", url: "/v1/sessions", headers: auth(testKey), payload: body(ok) });
      expect(res.statusCode, ok).toBe(201);
    }
  });
});
