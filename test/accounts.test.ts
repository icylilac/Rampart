import { randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { db } from "../src/lib/db";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { CHALLENGE_TTL_MS, createWalletChallenge, verifyWalletChallenge } from "../src/lib/wallet-challenge";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const uniqueEmail = () => `dev-${randomUUID().slice(0, 8)}@Example.com`;
const PASSWORD = "correct horse battery";
/** SEP-53 signature, base64, as a wallet returns it. */
const sign = (kp: Keypair, message: string) => Buffer.from(kp.signMessage(message)).toString("base64");

describe("passwords", () => {
  it("hashes with a fresh salt and verifies only the right password", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword("correct horse battery!", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, "not-a-hash")).toBe(false);
  });
});

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

  const signUp = async (email = uniqueEmail()) => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; user: { id: string; email: string } };
  };

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

  it("signs up, signs in with the same email in any case, and refuses a duplicate", async () => {
    const email = uniqueEmail();
    const created = await signUp(email);
    expect(created.token).toMatch(/^rds_/);
    expect(created.user.email).toBe(email.toLowerCase());

    const dup = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email: email.toUpperCase(), password: PASSWORD } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("email_taken");

    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: email.toUpperCase(), password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe(created.user.id);

    const me = await app.inject({ url: "/v1/auth/me", headers: bearer(login.json().token) });
    expect(me.json()).toMatchObject({ object: "user", id: created.user.id, email: email.toLowerCase(), wallet_address: null });
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const { user } = await signUp();
    const wrong = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: "nope nope nope" } });
    const unknown = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: uniqueEmail(), password: PASSWORD } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("rejects short passwords and bad emails", async () => {
    const short = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email: uniqueEmail(), password: "short" } });
    expect(short.statusCode).toBe(400);
    const bad = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email: "not-an-email", password: PASSWORD } });
    expect(bad.statusCode).toBe(400);
  });

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
