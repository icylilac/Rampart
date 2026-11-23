import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { db } from "../src/lib/db";
import { CHALLENGE_TTL_MS, createWalletChallenge, verifyWalletChallenge } from "../src/lib/wallet-challenge";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
/** SEP-53 signature, base64, as a wallet returns it. */
const sign = (kp: Keypair, message: string) => Buffer.from(kp.signMessage(message)).toString("base64");

describe("wallet challenges", () => {
  const secret = Buffer.alloc(32, 7);
  const kp = Keypair.random();

  it("accepts the wallet's SEP-53 signature of the challenge", () => {
    const c = createWalletChallenge(kp.publicKey(), secret);
    expect(c.message).toContain("Sign in to Rampart");
    expect(c.message).toContain(kp.publicKey());
    const signature = sign(kp, c.message);
    expect(verifyWalletChallenge({ address: kp.publicKey(), token: c.token, signature }, secret)).toEqual({ ok: true });
  });

  it("refuses another wallet's signature, a changed token, another address and an expired challenge", () => {
    const now = Date.now();
    const c = createWalletChallenge(kp.publicKey(), secret, now);
    const good = sign(kp, c.message);
    const other = Keypair.random();
    const check = (p: Partial<{ address: string; token: string; signature: string }>, at = now) =>
      verifyWalletChallenge({ address: kp.publicKey(), token: c.token, signature: good, ...p }, secret, at);

    expect(check({ signature: sign(other, c.message) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(check({ token: `${c.token.split(".")[0]}x.${c.token.split(".")[1]}` })).toEqual({ ok: false, reason: "tampered" });
    expect(check({ address: other.publicKey() })).toEqual({ ok: false, reason: "wrong_address" });
    expect(check({}, now + CHALLENGE_TTL_MS)).toEqual({ ok: false, reason: "expired" });
    expect(verifyWalletChallenge({ address: kp.publicKey(), token: c.token, signature: good }, Buffer.alloc(32, 8))).toEqual({
      ok: false,
      reason: "tampered",
    });
  });
});

describe("dashboard API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const walletSignIn = async (kp: Keypair) => {
    const c = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { address: kp.publicKey() } });
    expect(c.statusCode).toBe(200);
    const { message, token } = c.json() as { message: string; token: string };
    return app.inject({
      method: "POST",
      url: "/v1/auth/wallet",
      payload: { address: kp.publicKey(), token, signature: sign(kp, message) },
    });
  };

  /** A new wallet account, signed in. */
  const signUp = async () => {
    const res = await walletSignIn(Keypair.random());
    expect(res.statusCode).toBe(200);
    return res.json() as { token: string; user: { id: string } };
  };

  it("ends the session on sign-out", async () => {
    const { token } = await signUp();
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: bearer(token) })).statusCode).toBe(204);
    const me = await app.inject({ url: "/v1/auth/me", headers: bearer(token) });
    expect(me.statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/auth/me", headers: bearer("rds_made_up_token_aaaaaaaaaaaa") })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/auth/me" })).statusCode).toBe(401);
  });

  it("signs in with a wallet, creating the account once", async () => {
    const kp = Keypair.random();
    const first = await walletSignIn(kp);
    expect(first.statusCode).toBe(200);
    expect(first.json().user).toMatchObject({ email: null, wallet_address: kp.publicKey() });
    const second = await walletSignIn(kp);
    expect(second.json().user.id).toBe(first.json().user.id);
    expect(await db().user.count({ where: { walletAddress: kp.publicKey() } })).toBe(1);
  });

  it("refuses a wallet sign-in signed by someone else", async () => {
    const kp = Keypair.random();
    const c = (await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { address: kp.publicKey() } })).json();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet",
      payload: { address: kp.publicKey(), token: c.token, signature: sign(Keypair.random(), c.message) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_signature");
    expect(await db().user.count({ where: { walletAddress: kp.publicKey() } })).toBe(0);
    const bad = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { address: "GNOTANADDRESS" } });
    expect(bad.statusCode).toBe(400);
  });

  it("creates projects whose keys work, and keeps them private to their owner", async () => {
    const alice = await signUp();
    const bob = await signUp();

    const created = await app.inject({
      method: "POST",
      url: "/v1/dashboard/projects",
      headers: bearer(alice.token),
      payload: { name: "Alice's wallet", webhook_url: "https://alice.example/hooks/ramp" },
    });
    expect(created.statusCode).toBe(201);
    const { project, secrets } = created.json();
    expect(secrets.live_key).toMatch(/^rk_live_/);
    expect(secrets.test_key).toMatch(/^rk_test_/);
    expect(secrets.webhook_secret).toMatch(/^whsec_/);
    expect(project.api_keys.map((k: { mode: string }) => k.mode)).toEqual(["live", "test"]);
    expect(JSON.stringify(project)).not.toContain(secrets.test_key);

    // The test key is a working API key.
    expect((await app.inject({ url: "/v1/sessions", headers: bearer(secrets.test_key) })).statusCode).toBe(200);

    const list = (token: string) => app.inject({ url: "/v1/dashboard/projects", headers: bearer(token) });
    expect((await list(alice.token)).json().data.map((p: { id: string }) => p.id)).toEqual([project.id]);
    expect((await list(bob.token)).json().data).toEqual([]);

    // Bob can't add or revoke keys on Alice's project; it looks like it doesn't exist.
    const testKeyId = project.api_keys[1].id;
    const bobAdd = await app.inject({ method: "POST", url: `/v1/dashboard/projects/${project.id}/keys`, headers: bearer(bob.token), payload: { mode: "test" } });
    expect(bobAdd.statusCode).toBe(404);
    const bobRevoke = await app.inject({ method: "DELETE", url: `/v1/dashboard/projects/${project.id}/keys/${testKeyId}`, headers: bearer(bob.token) });
    expect(bobRevoke.statusCode).toBe(404);

    // Alice rolls the test key: a new one works, the revoked one stops.
    const added = await app.inject({ method: "POST", url: `/v1/dashboard/projects/${project.id}/keys`, headers: bearer(alice.token), payload: { mode: "test" } });
    expect(added.statusCode).toBe(201);
    expect(added.json().secret).toMatch(/^rk_test_/);
    const revoked = await app.inject({ method: "DELETE", url: `/v1/dashboard/projects/${project.id}/keys/${testKeyId}`, headers: bearer(alice.token) });
    expect(revoked.json().revoked_at).not.toBeNull();
    expect((await app.inject({ url: "/v1/sessions", headers: bearer(secrets.test_key) })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/sessions", headers: bearer(added.json().secret) })).statusCode).toBe(200);
  });

  it("lists a project's ramps per mode, newest first, only to its owner", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const created = await app.inject({ method: "POST", url: "/v1/dashboard/projects", headers: bearer(owner.token), payload: { name: "Ramps" } });
    const { project, secrets } = created.json();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: bearer(secrets.test_key),
        payload: { direction: "ON", wallet_address: Keypair.random().publicKey(), fiat_currency: "USD", fiat_amount: 10 + i, skip_preflight: true },
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().id);
    }
    const url = `/v1/dashboard/projects/${project.id}/sessions`;
    const page = await app.inject({ url: `${url}?limit=2`, headers: bearer(owner.token) });
    expect(page.statusCode).toBe(200);
    expect(page.json().data.map((s: { id: string }) => s.id)).toEqual([ids[2], ids[1]]);
    expect(page.json().has_more).toBe(true);
    expect(page.json().data[0]).not.toHaveProperty("client_secret");
    const rest = await app.inject({ url: `${url}?limit=2&starting_after=${ids[1]}`, headers: bearer(owner.token) });
    expect(rest.json()).toMatchObject({ data: [{ id: ids[0] }], has_more: false });
    expect((await app.inject({ url: `${url}?mode=live`, headers: bearer(owner.token) })).json().data).toEqual([]);
    expect((await app.inject({ url, headers: bearer(stranger.token) })).statusCode).toBe(404);
  });

  it("changes and removes a project's webhook URL, refusing internal addresses and strangers", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const { project } = (await app.inject({ method: "POST", url: "/v1/dashboard/projects", headers: bearer(owner.token), payload: { name: "Hooks" } })).json();
    const patch = (token: string, webhook_url: string | null) =>
      app.inject({ method: "PATCH", url: `/v1/dashboard/projects/${project.id}`, headers: bearer(token), payload: { webhook_url } });

    const set = await patch(owner.token, "https://hooks.example.com/ramp");
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ id: project.id, webhook_url: "https://hooks.example.com/ramp" });
    expect((await patch(owner.token, "https://10.0.0.5/hook")).statusCode).toBe(400);
    expect((await patch(stranger.token, "https://evil.example.com/")).statusCode).toBe(404);
    expect((await patch(owner.token, null)).json().webhook_url).toBeNull();
  });

  it("renames a project, and deleting it hides it and stops its keys", async () => {
    const owner = await signUp();
    const created = (await app.inject({ method: "POST", url: "/v1/dashboard/projects", headers: bearer(owner.token), payload: { name: "Old name" } })).json();
    const url = `/v1/dashboard/projects/${created.project.id}`;
    const renamed = await app.inject({ method: "PATCH", url, headers: bearer(owner.token), payload: { name: "  New name " } });
    expect(renamed.json()).toMatchObject({ name: "New name", webhook_url: null });
    expect((await app.inject({ method: "PATCH", url, headers: bearer(owner.token), payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ url: "/v1/sessions", headers: bearer(created.secrets.test_key) })).statusCode).toBe(200);

    expect((await app.inject({ method: "DELETE", url, headers: bearer(owner.token) })).statusCode).toBe(204);
    expect((await app.inject({ url: "/v1/dashboard/projects", headers: bearer(owner.token) })).json().data).toEqual([]);
    expect((await app.inject({ url: "/v1/sessions", headers: bearer(created.secrets.test_key) })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url, headers: bearer(owner.token), payload: { name: "Back" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url, headers: bearer(owner.token) })).statusCode).toBe(404);
    expect(await db().project.count({ where: { id: created.project.id } })).toBe(1);
  });

  it("needs a signed-in user, not an API key, for the dashboard", async () => {
    expect((await app.inject({ url: "/v1/dashboard/projects" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/dashboard/projects", headers: bearer("rk_test_" + "a".repeat(24)) })).statusCode).toBe(401);
  });

  it("lets browsers on any origin call it with a bearer token", async () => {
    const pre = await app.inject({ method: "OPTIONS", url: "/v1/dashboard/projects", headers: { origin: "https://userampart.vercel.app" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
    expect(pre.headers["access-control-allow-methods"]).toContain("DELETE");
    const err = await app.inject({ url: "/v1/auth/me" });
    expect(err.headers["access-control-allow-origin"]).toBe("*");
    expect((await app.inject({ url: "/v1/providers" })).headers["access-control-allow-origin"]).toBeUndefined();
  });
});
