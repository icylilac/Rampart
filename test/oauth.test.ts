import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app";
import { resetConfig } from "../src/config";
import { db } from "../src/lib/db";

const SUPABASE_URL = "https://example-ref.supabase.co";
const VERIFIER = "v".repeat(43);
const uniqueEmail = () => `oauth-${randomUUID().slice(0, 8)}@Example.com`;

/** Answers Supabase's PKCE token exchange; anything else is a test bug. */
function supabaseReturns(status: number, body: unknown) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(SUPABASE_URL)) return realFetch(input, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
}

const confirmed = (email: string, provider = "google") => ({
  access_token: "sb-access",
  user: { email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider } },
});

describe("sign-in through Supabase Auth", () => {
  let app: FastifyInstance;
  const signIn = (code = "one-time-code") =>
    app.inject({ method: "POST", url: "/v1/auth/oauth", payload: { code, code_verifier: VERIFIER } });

  beforeAll(async () => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = "anon-key";
    resetConfig();
    app = buildServer();
    await app.ready();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    resetConfig();
  });

  it("trades the code with the verifier and creates the account once", async () => {
    const email = uniqueEmail();
    const fetchSpy = supabaseReturns(200, confirmed(email));
    const first = await signIn();
    expect(first.statusCode).toBe(200);
    expect(first.json().token).toMatch(/^rds_/);
    expect(first.json().user).toMatchObject({ email: email.toLowerCase(), wallet_address: null });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`);
    expect(init?.headers).toMatchObject({ apikey: "anon-key" });
    expect(JSON.parse(String(init?.body))).toEqual({ auth_code: "one-time-code", code_verifier: VERIFIER });

    const second = await signIn();
    expect(second.json().user.id).toBe(first.json().user.id);
    expect(await db().user.count({ where: { email: email.toLowerCase() } })).toBe(1);
    const me = await app.inject({ url: "/v1/auth/me", headers: { authorization: `Bearer ${second.json().token}` } });
    expect(me.statusCode).toBe(200);
  });

  it("joins an existing email + password account with the same address", async () => {
    const email = uniqueEmail();
    const signup = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email, password: "correct horse battery" } });
    supabaseReturns(200, confirmed(email.toUpperCase(), "github"));
    const res = await signIn();
    expect(res.json().user.id).toBe(signup.json().user.id);
  });

  it("refuses a bad code and an unconfirmed email", async () => {
    supabaseReturns(400, { error: "invalid_grant" });
    const bad = await signIn("used-code");
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("oauth_failed");

    vi.restoreAllMocks();
    supabaseReturns(200, { user: { email: uniqueEmail(), email_confirmed_at: null } });
    const unconfirmed = await signIn();
    expect(unconfirmed.statusCode).toBe(401);
    expect(unconfirmed.json().error.code).toBe("oauth_no_email");
  });

  it("rejects a malformed verifier before calling Supabase", async () => {
    const fetchSpy = supabaseReturns(200, confirmed(uniqueEmail()));
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: { code: "c", code_verifier: "short" } });
    expect(res.statusCode).toBe(400);
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).startsWith(SUPABASE_URL))).toHaveLength(0);
  });
});
