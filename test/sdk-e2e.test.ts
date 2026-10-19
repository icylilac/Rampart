import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RampRunner } from "../packages/sdk/src/browser";
import { RicercaError, RicercaRamp } from "../packages/sdk/src/index";
import { buildServer } from "../src/app";
import { deliverDue } from "../src/engine/outbound";
import { encrypt } from "../src/lib/crypto";
import { db } from "../src/lib/db";
import { newApiKey } from "../src/lib/keys";

/** The SDK against the real server over HTTP, in test mode. */
let app: FastifyInstance;
let baseUrl: string;
let ramp: RicercaRamp;
const webhookSecret = "whsec_e2e_secret";

beforeAll(async () => {
  app = buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const test = newApiKey("TEST");
  await db().project.create({
    data: {
      name: "SDK e2e",
      webhookUrl: "https://project.example/e2e",
      webhookSecretEnc: encrypt(webhookSecret),
      apiKeys: { create: [{ mode: "TEST", keyHash: test.hash, prefix: test.prefix }] },
    },
  });
  ramp = new RicercaRamp(test.key, { baseUrl });
});

afterAll(async () => {
  await app.close();
});

describe("SDK end to end (test mode)", () => {
  it("off-ramp: the browser runner signs the payment and follows it to COMPLETED", async () => {
    const wallet = Keypair.random();
    const created = await ramp.sessions.create({
      direction: "OFF",
      wallet_address: wallet.publicKey(),
      asset: "USDC",
      crypto_amount: "12.5",
      external_reference: `e2e-${Date.now()}`,
    });
    expect(created.provider).toBe("SANDBOX");
    expect(created.client_secret).toBeDefined();

    const statuses: string[] = [];
    const runner = new RampRunner({
      sessionId: created.id,
      clientSecret: created.client_secret!,
      baseUrl,
      pollIntervalMs: 50,
      openUrl: () => {}, // the sandbox checkout page; nothing to do in a test
      // A real wallet signature, as Freighter or Stellar Wallets Kit would produce.
      signTransaction: async (xdr, { networkPassphrase }) => {
        const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
        tx.sign(wallet);
        return tx.toXDR();
      },
      onUpdate: (s) => statuses.push(s.status),
    });
    const done = runner.start();

    // Drive the scenario forward instead of waiting for real time.
    for (let i = 0; i < 40; i++) {
      const r = await ramp.sandbox.advance(created.id);
      if (r.session.status === "COMPLETED") break;
      await new Promise((res) => setTimeout(res, 60));
    }
    const final = await done;

    expect(final.status).toBe("COMPLETED");
    expect(final.onchain_verified).toBe(true);
    expect(statuses).toContain("AWAITING_PAYMENT");
    expect(statuses).toContain("PROCESSING");

    const events = await ramp.sessions.events(created.id);
    expect(events.status_changes.map((c) => c.to)).toEqual(["AWAITING_USER", "AWAITING_PAYMENT", "PROCESSING", "COMPLETED"]);
  });

  it("webhooks the service sends verify with the SDK", async () => {
    const received: { body: string; sig: string }[] = [];
    // Other test files' projects share this database; check only this project's deliveries.
    await deliverDue(200, async (url, init) => {
      if (url !== "https://project.example/e2e") return new Response(null, { status: 204 });
      received.push({ body: String(init?.body), sig: String((init?.headers as Record<string, string>)["Ricerca-Signature"]) });
      return new Response(null, { status: 204 });
    });
    expect(received.length).toBeGreaterThan(0);
    for (const r of received) {
      const event = RicercaRamp.webhooks.constructEvent(r.body, r.sig, webhookSecret);
      expect(event.type).toBe("ramp_session.updated");
      expect(event.livemode).toBe(false);
    }
  });

  it("API errors arrive as RicercaError with the API's code", async () => {
    const err = await ramp.sessions.create({ direction: "ON", wallet_address: "nope", fiat_amount: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(RicercaError);
    expect(err.code).toBe("invalid_wallet");
    const all: string[] = [];
    for await (const s of ramp.sessions.listAll({ limit: 1 })) all.push(s.id);
    expect(all.length).toBeGreaterThanOrEqual(1);
  });
});
