import { randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app";
import { resetConfig } from "../src/config";
import { db } from "../src/lib/db";

const SUPABASE_URL = "https://example-ref.supabase.co";
const sign = (kp: Keypair, message: string) => Buffer.from(kp.signMessage(message)).toString("base64");

type Handler = (url: URL, init: RequestInit | undefined) => { status: number; body: unknown };

/** Stands in for Supabase Auth; every other request goes out as normal. */
function supabase(handler: Handler) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== SUPABASE_URL) return realFetch(input, init);
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
}

const authUser = (email = `dev-${randomUUID().slice(0, 8)}@Example.com`, confirmed = true) => ({
  id: randomUUID(),
  email,
  email_confirmed_at: confirmed ? new Date().toISOString() : null,
});

describe("Supabase Auth sign-in", () => {
  let app: FastifyInstance;
  const exchange = (access_token = "sb-access-token") => app.inject({ method: "POST", url: "/v1/auth/supabase", payload: { access_token } });
  const walletSignIn = async (kp: Keypair) => {
    const c = (await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { address: kp.publicKey() } })).json();
    return app.inject({ method: "POST", url: "/v1/auth/wallet", payload: { address: kp.publicKey(), token: c.token, signature: sign(kp, c.message) } });
  };

  beforeAll(async () => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    resetConfig();
    app = buildServer();
    await app.ready();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetConfig();
  });

  it("checks the access token with Supabase and links the account to its user id", async () => {
    const u = authUser();
    const spy = supabase(() => ({ status: 200, body: u }));
    const first = await exchange();
    expect(first.statusCode).toBe(200);
    expect(first.json().token).toMatch(/^rds_/);
    expect(first.json().user).toMatchObject({ email: u.email.toLowerCase(), supabase_user_id: u.id, wallet_address: null });

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe(`${SUPABASE_URL}/auth/v1/user`);
    expect(init?.headers).toMatchObject({ apikey: "anon-key", Authorization: "Bearer sb-access-token" });

    // Same Supabase user, new email: same account, email updated.
    vi.restoreAllMocks();
    const renamed = `new-${u.email.toLowerCase()}`;
    supabase(() => ({ status: 200, body: { ...u, email: renamed } }));
    const second = await exchange();
    expect(second.json().user).toMatchObject({ id: first.json().user.id, email: renamed });
    expect(await db().user.count({ where: { authUserId: u.id } })).toBe(1);
  });

  it("refuses an expired token and an unconfirmed email", async () => {
    supabase(() => ({ status: 401, body: { msg: "invalid JWT" } }));
    const expired = await exchange();
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe("invalid_login");

    vi.restoreAllMocks();
    supabase(() => ({ status: 200, body: authUser(undefined, false) }));
    const unconfirmed = await exchange();
    expect(unconfirmed.statusCode).toBe(403);
    expect(unconfirmed.json().error.code).toBe("email_unconfirmed");
  });

  it("gives a wallet account a Supabase Auth user once, with the address in its metadata", async () => {
    const kp = Keypair.random();
    const id = randomUUID();
    const created: unknown[] = [];
    supabase((url, init) => {
      expect(url.pathname).toBe("/auth/v1/admin/users");
      expect(init?.headers).toMatchObject({ apikey: "service-key", Authorization: "Bearer service-key" });
      created.push(JSON.parse(String(init?.body)));
      return { status: 200, body: { id } };
    });
    const first = await walletSignIn(kp);
    expect(first.statusCode).toBe(200);
    expect(first.json().user).toMatchObject({ wallet_address: kp.publicKey(), supabase_user_id: id, email: null });
    expect(created).toEqual([
      {
        email: `${kp.publicKey().toLowerCase()}@wallet.rampartpay.xyz`,
        email_confirm: true,
        app_metadata: { provider: "stellar", providers: ["stellar"], wallet_address: kp.publicKey() },
        user_metadata: { wallet_address: kp.publicKey() },
      },
    ]);
    // Already linked: no second Supabase user.
    expect((await walletSignIn(kp)).json().user.supabase_user_id).toBe(id);
    expect(created).toHaveLength(1);
  });

  it("still signs a wallet in when Supabase is down, and links it next time", async () => {
    const kp = Keypair.random();
    vi.spyOn(console, "error").mockImplementation(() => {});
    supabase(() => ({ status: 500, body: {} }));
    const down = await walletSignIn(kp);
    expect(down.statusCode).toBe(200);
    expect(down.json().user.supabase_user_id).toBeNull();

    vi.restoreAllMocks();
    const id = randomUUID();
    // The earlier attempt may have created it after all: 422, then found by email.
    supabase((url, init) =>
      init?.method === "POST" ? { status: 422, body: { error_code: "email_exists" } } : { status: 200, body: { users: [{ id, email: decodeURIComponent(url.searchParams.get("filter")!) }] } },
    );
    expect((await walletSignIn(kp)).json().user.supabase_user_id).toBe(id);
  });
});
