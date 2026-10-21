import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { deliverDue, signPayload } from "../src/engine/outbound";
import { reconcileOnce } from "../src/engine/reconciler";
import { applyUpdate } from "../src/engine/sessions";
import { encrypt, hmacHex } from "../src/lib/crypto";
import { db } from "../src/lib/db";
import { newApiKey } from "../src/lib/keys";
import { networkPassphrase } from "../src/stellar/network";

let app: FastifyInstance;
let liveKey: string;
let testKey: string;
const webhookSecret = "whsec_test_project_secret";
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const wallet = () => Keypair.random();
// The project's webhook host (project.example) doesn't resolve; pretend it's public.
const publicDns = async () => ["203.0.113.7"];

type Session = {
  id: string;
  status: string;
  livemode: boolean;
  provider: string;
  next_action: { type: string; xdr?: string; url?: string; memo?: string };
  onchain_verified: boolean | null;
  failure_reason: string | null;
  client_secret?: string;
  stellar_tx_hash: string | null;
};

async function create(body: Record<string, unknown>, key = testKey) {
  const res = await app.inject({ method: "POST", url: "/v1/sessions", headers: auth(key), payload: body });
  return { status: res.statusCode, body: res.json() as Session & { error?: { code: string } } };
}

async function advance(id: string) {
  const res = await app.inject({ method: "POST", url: `/v1/sandbox/sessions/${id}/advance`, headers: auth(testKey) });
  expect(res.statusCode).toBe(200);
  return res.json() as { advanced: boolean; reason: string | null; session: Session };
}

/** Advances until the scenario has nothing left to do; returns every status seen. */
async function runToEnd(id: string) {
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await advance(id);
    seen.push(r.session.status);
    if (!r.advanced) return { seen, final: r.session, reason: r.reason };
  }
  throw new Error("scenario did not finish");
}

async function transitions(id: string) {
  const res = await app.inject({ method: "GET", url: `/v1/sessions/${id}/events`, headers: auth(testKey) });
  return res.json() as { status_changes: { from: string; to: string; source: string }[]; provider_events: { id: string }[] };
}

beforeAll(async () => {
  app = buildServer();
  const live = newApiKey("LIVE");
  const test = newApiKey("TEST");
  liveKey = live.key;
  testKey = test.key;
  await db().project.create({
    data: {
      name: "Test project",
      webhookUrl: "https://project.example/hooks",
      webhookSecretEnc: encrypt(webhookSecret),
      apiKeys: {
        create: [
          { mode: "LIVE", keyHash: live.hash, prefix: live.prefix },
          { mode: "TEST", keyHash: test.hash, prefix: test.prefix },
        ],
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await db().$disconnect();
});

describe("auth", () => {
  it("rejects missing and unknown keys", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/sessions" })).statusCode).toBe(401);
    const bogus = newApiKey("TEST").key;
    expect((await app.inject({ method: "GET", url: "/v1/sessions", headers: auth(bogus) })).statusCode).toBe(401);
  });

  it("keeps live and test data apart", async () => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), asset: "USDC", fiat_amount: 25, fiat_currency: "USD" });
    expect(body.livemode).toBe(false);
    const asLive = await app.inject({ method: "GET", url: `/v1/sessions/${body.id}`, headers: auth(liveKey) });
    expect(asLive.statusCode).toBe(404);
  });

  it("live keys can't use the sandbox", async () => {
    const r = await create({ direction: "ON", provider: "SANDBOX", wallet_address: wallet().publicKey(), fiat_amount: 10 }, liveKey);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("sandbox_requires_test_key");
  });
});

describe("test mode: on-ramp scenarios", () => {
  it("success: completes, verifies and records every transition", async () => {
    const { status, body } = await create({
      direction: "ON",
      provider: "STRIPE",
      wallet_address: wallet().publicKey(),
      asset: "USDC",
      fiat_amount: 50,
      fiat_currency: "USD",
    });
    expect(status).toBe(201);
    expect(body.provider).toBe("SANDBOX");
    expect(body.status).toBe("AWAITING_USER");
    expect(body.next_action.type).toBe("open_url");
    expect(body.client_secret).toMatch(/^rcs_/);

    const { final } = await runToEnd(body.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.onchain_verified).toBe(true);
    const t = await transitions(body.id);
    expect(t.status_changes.map((c) => c.to)).toEqual(["AWAITING_USER", "AWAITING_PAYMENT", "PROCESSING", "COMPLETED"]);
  });

  it("missing_webhooks: polling alone finds every step", async () => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 20, sandbox_scenario: "missing_webhooks" });
    const { final } = await runToEnd(body.id);
    expect(final.status).toBe("COMPLETED");
    const t = await transitions(body.id);
    expect(t.provider_events).toHaveLength(0);
    expect(t.status_changes.filter((c) => c.source === "poll").length).toBeGreaterThanOrEqual(3);
  });

  it("out_of_order_webhooks: stale webhooks never move it backwards", async () => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 20, sandbox_scenario: "out_of_order_webhooks" });
    const { seen, final } = await runToEnd(body.id);
    expect(final.status).toBe("COMPLETED");
    expect(seen.slice(seen.indexOf("COMPLETED"))).toEqual(seen.slice(seen.indexOf("COMPLETED")).map(() => "COMPLETED"));
    const t = await transitions(body.id);
    expect(t.status_changes.every((c) => c.from !== "COMPLETED")).toBe(true);
  });

  it("late_webhook: a stale PROCESSING after completion is ignored", async () => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 20, sandbox_scenario: "late_webhook" });
    const { final } = await runToEnd(body.id);
    expect(final.status).toBe("COMPLETED");
    expect((await transitions(body.id)).provider_events.length).toBe(4);
  });

  it("completed_not_delivered: flags the missing delivery", async () => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 20, sandbox_scenario: "completed_not_delivered" });
    const { final } = await runToEnd(body.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.onchain_verified).toBe(false);
  });

  it.each([
    ["kyc_rejected", "FAILED"],
    ["expired", "EXPIRED"],
    ["refunded", "REFUNDED"],
  ])("%s ends %s", async (scenario, expected) => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 20, sandbox_scenario: scenario });
    const { final } = await runToEnd(body.id);
    expect(final.status).toBe(expected);
    if (expected !== "REFUNDED") expect(final.failure_reason).toBeTruthy();
  });

  it("rejects an unknown scenario", async () => {
    const r = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 20, sandbox_scenario: "nope" });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("invalid_scenario");
  });
});

describe("test mode: off-ramp", () => {
  it("the wallet signs the exact payment through the client secret", async () => {
    const kp = wallet();
    const { body } = await create({ direction: "OFF", wallet_address: kp.publicKey(), asset: "USDC", crypto_amount: "15.5" });
    const step = await advance(body.id);
    expect(step.session.status).toBe("AWAITING_PAYMENT");
    expect(step.session.next_action.type).toBe("sign_payment");
    expect((await advance(body.id)).reason).toBe("waiting_for_payment");

    const tx = TransactionBuilder.fromXDR(step.session.next_action.xdr!, networkPassphrase());
    tx.sign(kp);
    const cs = { authorization: `Bearer ${body.client_secret}` };
    const read = await app.inject({ method: "GET", url: `/v1/client/sessions/${body.id}`, headers: cs });
    expect(read.statusCode).toBe(200);
    expect(read.headers["access-control-allow-origin"]).toBe("*");

    const submit = await app.inject({ method: "POST", url: `/v1/client/sessions/${body.id}/transactions`, headers: cs, payload: { signed_xdr: tx.toXDR() } });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("PROCESSING");

    const { final } = await runToEnd(body.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.onchain_verified).toBe(true);
  });

  it("refuses an unsigned payment", async () => {
    const kp = wallet();
    const { body } = await create({ direction: "OFF", wallet_address: kp.publicKey(), crypto_amount: 5 });
    const step = await advance(body.id);
    const cs = { authorization: `Bearer ${body.client_secret}` };
    const res = await app.inject({ method: "POST", url: `/v1/client/sessions/${body.id}/transactions`, headers: cs, payload: { signed_xdr: step.session.next_action.xdr } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unsigned");
  });

  it("a client secret only opens its own session", async () => {
    const a = await create({ direction: "OFF", wallet_address: wallet().publicKey(), crypto_amount: 5 });
    const b = await create({ direction: "OFF", wallet_address: wallet().publicKey(), crypto_amount: 5 });
    const res = await app.inject({ method: "GET", url: `/v1/client/sessions/${b.body.id}`, headers: { authorization: `Bearer ${a.body.client_secret}` } });
    expect(res.statusCode).toBe(404);
    const asKey = await app.inject({ method: "GET", url: "/v1/sessions", headers: { authorization: `Bearer ${a.body.client_secret}` } });
    expect(asKey.json().error.code).toBe("client_secret_not_allowed");
  });
});

describe("sessions API", () => {
  it("is idempotent on external_reference", async () => {
    const w = wallet().publicKey();
    const req = { direction: "ON", wallet_address: w, fiat_amount: 30, external_reference: `order-${Date.now()}` };
    const first = await create(req);
    const again = await create(req);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.client_secret).toBeUndefined();
    const different = await create({ ...req, fiat_amount: 31 });
    expect(different.status).toBe(409);
  });

  it("lists with cursor pagination", async () => {
    const page1 = await app.inject({ method: "GET", url: "/v1/sessions?limit=2", headers: auth(testKey) });
    const p1 = page1.json() as { data: Session[]; has_more: boolean };
    expect(p1.data).toHaveLength(2);
    expect(p1.has_more).toBe(true);
    const page2 = await app.inject({ method: "GET", url: `/v1/sessions?limit=2&starting_after=${p1.data[1].id}`, headers: auth(testKey) });
    const p2 = page2.json() as { data: Session[] };
    expect(p2.data[0].id).not.toBe(p1.data[0].id);
    expect(p2.data[0].id).not.toBe(p1.data[1].id);
  });

  it("validates input", async () => {
    const r = await create({ direction: "ON", wallet_address: "not-a-wallet", fiat_amount: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("invalid_wallet");
    const noAmount = await create({ direction: "ON", wallet_address: wallet().publicKey() });
    expect(noAmount.body.error?.code).toBe("validation_error");
  });
});

describe("reconciler", () => {
  it("ignores a stale poll that would move a session backwards, but not a fresh one", async () => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 10 });
    const asked = new Date(Date.now() - 5_000); // the provider was asked before the payment landed
    await applyUpdate(body.id, { status: "PROCESSING", providerStatus: "paid" }, "submit", "wallet payment submitted");

    const stale = await applyUpdate(body.id, { status: "AWAITING_PAYMENT", providerStatus: "waiting" }, "poll", "test", { observedAt: asked });
    expect(stale.changed).toBe(false);
    expect(stale.ignored).toMatch(/predates/);
    expect(stale.session.status).toBe("PROCESSING");

    // A poll asked after the last change may still move it back (e.g. an anchor needs more info).
    const fresh = await applyUpdate(body.id, { status: "AWAITING_PAYMENT", providerStatus: "waiting" }, "poll", "test", { observedAt: new Date() });
    expect(fresh.session.status).toBe("AWAITING_PAYMENT");
  });

  it("expires an abandoned session after a last look at the provider", async () => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 10 });
    await db().rampSession.update({ where: { id: body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await reconcileOnce(new Date(), () => {});
    const s = await db().rampSession.findUniqueOrThrow({ where: { id: body.id } });
    expect(s.status).toBe("EXPIRED");
  });
});

describe("outbound webhooks", () => {
  it("delivers signed events the project can verify", async () => {
    const received: { body: string; signature: string }[] = [];
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      received.push({ body: String(init?.body), signature: String((init?.headers as Record<string, string>)["Rampart-Signature"]) });
      return new Response(null, { status: 200 });
    };
    while ((await deliverDue(100, fakeFetch, new Date(), publicDns)) > 0);
    expect(received.length).toBeGreaterThan(0);
    for (const { body, signature } of received) {
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signature)!;
      expect(v1).toBe(hmacHex(webhookSecret, `${t}.${body}`));
      expect(JSON.parse(body).type).toBe("ramp_session.updated");
    }
    expect(signPayload("s", "b", 1)).toBe(`t=1,v1=${hmacHex("s", "1.b")}`);
  });

  it("retries failed deliveries with backoff", async () => {
    const { body } = await create({ direction: "ON", wallet_address: wallet().publicKey(), fiat_amount: 10 });
    const failing = async () => new Response(null, { status: 500 });
    // Other test files' deliveries share this database; drain until this one is attempted.
    while ((await deliverDue(100, failing, new Date(), publicDns)) > 0);
    const retried = await db().webhookDelivery.findFirstOrThrow({ where: { sessionId: body.id } });
    expect(retried.status).toBe("PENDING");
    expect(retried.attempts).toBe(1);
    expect(retried.lastStatusCode).toBe(500);
    expect(retried.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });
});

describe("inbound provider webhooks", () => {
  it("rejects a bad signature and deduplicates retries", async () => {
    const bad = await app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "stripe-signature": "t=1,v1=00" }, payload: { id: "evt_1", type: "x" } });
    expect(bad.statusCode).toBe(400);

    const body = JSON.stringify({ id: `evt_${Date.now()}`, type: "crypto.onramp_session.updated", data: { object: { id: "cos_unknown", client_secret: "x", status: "fulfillment_complete" } } });
    const t = Math.floor(Date.now() / 1000);
    const headers = { "content-type": "application/json", "stripe-signature": `t=${t},v1=${hmacHex("whsec_test_stripe", `${t}.${body}`)}` };
    const first = await app.inject({ method: "POST", url: "/webhooks/stripe", headers, payload: body });
    expect(first.json().outcome).toBe("unmatched");
    const second = await app.inject({ method: "POST", url: "/webhooks/stripe", headers, payload: body });
    expect(second.json().outcome).toBe("duplicate");
  });
});
