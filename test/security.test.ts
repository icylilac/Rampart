import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { deliverDue } from "../src/engine/outbound";
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
    process.env.AUTH_RATE_LIMIT_PER_MINUTE = "3";
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
    process.env.AUTH_RATE_LIMIT_PER_MINUTE = "0";
    resetConfig();
    await app.close();
  });

  it("limits sign-in attempts per IP more tightly than the API", async () => {
    const attempt = () =>
      app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress: "203.0.113.9", payload: { email: "guess@example.com", password: "guess guess guess" } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await attempt()).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    // Another IP still gets its own attempts.
    const other = await app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress: "203.0.113.10", payload: { email: "x@example.com", password: "guess guess guess" } });
    expect(other.statusCode).toBe(401);
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

  it("won't save a webhook URL that points at an internal address", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      remoteAddress: "203.0.113.20",
      payload: { email: `ssrf-${Date.now()}@example.com`, password: "a long enough password" },
    });
    const headers = auth(signup.json().token);
    for (const webhook_url of ["https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/hooks", "http://localhost:3000/hooks", "https://[::1]/"]) {
      const res = await app.inject({ method: "POST", url: "/v1/dashboard/projects", headers, payload: { name: "SSRF", webhook_url } });
      expect(res.statusCode, webhook_url).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
  });

  it("refuses to deliver to internal addresses and doesn't follow redirects", async () => {
    const project = async (url: string) => {
      const p = await db().project.create({ data: { name: "Delivery target", webhookUrl: url, webhookSecretEnc: encrypt("whsec_target") } });
      const session = await db().rampSession.create({
        data: {
          projectId: p.id,
          direction: "ON",
          provider: "SANDBOX",
          walletAddress: Keypair.random().publicKey(),
          assetCode: "USDC",
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const delivery = await db().webhookDelivery.create({
        data: { projectId: p.id, sessionId: session.id, eventType: "ramp_session.updated", payload: { id: `evt_${session.id}` } },
      });
      return { deliveries: [delivery] };
    };
    const internal = await project("https://internal.example/hooks");
    const redirecting = await project("https://redirect.example/hooks");
    // Literal addresses saved before the dashboard checked them are caught at delivery too.
    const literal = await project("https://169.254.169.254/latest/meta-data/");

    const fetched: string[] = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      fetched.push(url);
      expect(init?.redirect).toBe("manual");
      return url.startsWith("https://redirect.example")
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
        : new Response(null, { status: 200 });
    };
    const dns = async (host: string) => (host === "internal.example" ? ["10.0.0.5"] : ["203.0.113.7"]);
    // Other test files' deliveries share this database; drain until these are attempted.
    while ((await deliverDue(100, fakeFetch, new Date(), dns)) > 0);

    expect(fetched).not.toContain("https://internal.example/hooks");
    expect(fetched.some((u) => u.startsWith("https://169.254.169.254"))).toBe(false);
    const after = async (p: { deliveries: { id: string }[] }) => db().webhookDelivery.findUniqueOrThrow({ where: { id: p.deliveries[0].id } });
    const a = await after(internal);
    expect(a.status).toBe("PENDING");
    expect(a.lastError).toMatch(/resolves to 10\.0\.0\.5/);
    expect((await after(literal)).lastError).toMatch(/Webhook URL refused/);
    const r = await after(redirecting);
    expect(r.status).toBe("PENDING");
    expect(r.lastStatusCode).toBe(302);
    expect(r.lastError).toMatch(/redirects are not followed/);
    expect(fetched.filter((u) => u === "https://redirect.example/hooks")).toHaveLength(1);

    // Don't leave retries for other test files' drains to pick up.
    await db().webhookDelivery.deleteMany({ where: { id: { in: [internal, redirecting, literal].map((p) => p.deliveries[0].id) } } });
  });
});
