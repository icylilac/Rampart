import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RampRunner, stellarWalletsKitSigner } from "../src/browser";
import { RicercaError, RicercaRamp, RicercaSignatureError, type RampSession } from "../src/index";

const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

function session(overrides: Partial<RampSession>): RampSession {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    object: "ramp_session",
    livemode: false,
    direction: "OFF",
    provider: "SANDBOX",
    status: "AWAITING_USER",
    provider_status: null,
    wallet_address: "G...",
    asset: { code: "USDC", issuer: null },
    fiat_currency: null,
    fiat_amount: null,
    crypto_amount: "10",
    external_reference: null,
    anchor_domain: null,
    next_action: { type: "none" },
    stellar_tx_hash: null,
    onchain_verified: null,
    onchain_check: null,
    failure_reason: null,
    expires_at: null,
    completed_at: null,
    created_at: "2026-10-08T00:00:00Z",
    updated_at: "2026-10-08T00:00:00Z",
    ...overrides,
  };
}

describe("RicercaRamp (server)", () => {
  it("rejects anything that isn't a project key", () => {
    expect(() => new RicercaRamp("rcs_abc")).toThrow(RicercaError);
    expect(new RicercaRamp("rk_test_abc").livemode).toBe(false);
    expect(new RicercaRamp("rk_live_abc").livemode).toBe(true);
  });

  it("sends the key and body, and surfaces API errors with their code", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ramp = new RicercaRamp("rk_test_key", {
      baseUrl: "https://ramp.example.com",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ error: { code: "preflight_failed", message: "Not ready", details: { issues: [] } } }), { status: 422 });
      },
    });
    const err = await ramp.sessions.create({ direction: "ON", wallet_address: "G", fiat_amount: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(RicercaError);
    expect(err.code).toBe("preflight_failed");
    expect(err.status).toBe(422);
    expect(calls).toHaveLength(1); // a create without external_reference is never retried
    expect(calls[0].url).toBe("https://ramp.example.com/v1/sessions");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer rk_test_key");
  });

  it("retries safe requests on 503", async () => {
    let n = 0;
    const ramp = new RicercaRamp("rk_test_key", {
      fetch: async () => (++n < 3 ? new Response("{}", { status: 503 }) : new Response(JSON.stringify(session({})), { status: 200 })),
    });
    expect((await ramp.sessions.retrieve("x")).id).toBe(session({}).id);
    expect(n).toBe(3);
  });

  it("pages through every session", async () => {
    const pages = [
      { object: "list", data: [session({ id: "a" }), session({ id: "b" })], has_more: true },
      { object: "list", data: [session({ id: "c" })], has_more: false },
    ];
    const seen: string[] = [];
    const ramp = new RicercaRamp("rk_test_key", {
      fetch: async (url) => {
        seen.push(new URL(url).searchParams.get("starting_after") ?? "");
        return new Response(JSON.stringify(pages[seen.length - 1]), { status: 200 });
      },
    });
    const ids: string[] = [];
    for await (const s of ramp.sessions.listAll()) ids.push(s.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(seen).toEqual(["", "b"]);
  });
});

describe("webhooks.constructEvent", () => {
  const body = JSON.stringify({ id: "evt_1", type: "ramp_session.updated", data: { object: { id: "s" } } });
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it("accepts a valid signature", () => {
    expect(RicercaRamp.webhooks.constructEvent(body, sign("whsec_x", t, body), "whsec_x", 300, now).id).toBe("evt_1");
  });

  it("rejects a wrong secret, a changed body and an old timestamp", () => {
    expect(() => RicercaRamp.webhooks.constructEvent(body, sign("whsec_y", t, body), "whsec_x", 300, now)).toThrow(RicercaSignatureError);
    expect(() => RicercaRamp.webhooks.constructEvent(body + " ", sign("whsec_x", t, body), "whsec_x", 300, now)).toThrow(RicercaSignatureError);
    expect(() => RicercaRamp.webhooks.constructEvent(body, sign("whsec_x", t - 600, body), "whsec_x", 300, now)).toThrow(RicercaSignatureError);
    expect(() => RicercaRamp.webhooks.constructEvent(body, undefined, "whsec_x", 300, now)).toThrow(RicercaSignatureError);
  });
});

describe("RampRunner (browser)", () => {
  it("signs and submits the payment, then follows the session to the end", async () => {
    const states = [
      session({ status: "AWAITING_PAYMENT", updated_at: "1", next_action: { type: "sign_payment", xdr: "UNSIGNED", network_passphrase: "Test SDF Network ; September 2015", destination: "G", amount: "10", asset: { code: "USDC", issuer: null }, memo: "m", memo_type: "text" } }),
      session({ status: "COMPLETED", updated_at: "3", onchain_verified: true }),
    ];
    const requests: string[] = [];
    let posted: unknown;
    const runner = new RampRunner({
      sessionId: states[0].id,
      clientSecret: "rcs_secret",
      pollIntervalMs: 1,
      signTransaction: async (xdr, { networkPassphrase }) => {
        expect(networkPassphrase).toContain("Test SDF");
        return `${xdr}+SIGNED`;
      },
      fetch: async (url, init) => {
        requests.push(`${init?.method} ${new URL(url).pathname}`);
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer rcs_secret");
        if (init?.method === "POST") {
          posted = JSON.parse(String(init.body));
          return new Response(JSON.stringify(session({ status: "PROCESSING", updated_at: "2" })), { status: 200 });
        }
        return new Response(JSON.stringify(requests.length === 1 ? states[0] : states[1]), { status: 200 });
      },
    });
    const updates: string[] = [];
    (runner as unknown as { options: { onUpdate: (s: RampSession) => void } }).options.onUpdate = (s) => updates.push(s.status);

    const final = await runner.start();
    expect(final.status).toBe("COMPLETED");
    expect(posted).toEqual({ signed_xdr: "UNSIGNED+SIGNED" });
    expect(requests[1]).toMatch(/^POST \/v1\/client\/sessions\/.+\/transactions$/);
    expect(updates).toEqual(["AWAITING_PAYMENT", "PROCESSING", "COMPLETED"]);
  });

  it("opens each provider URL once", async () => {
    const opened: string[] = [];
    let n = 0;
    const runner = new RampRunner({
      sessionId: "s",
      clientSecret: "rcs_x",
      pollIntervalMs: 1,
      openUrl: (url) => {
        opened.push(url);
      },
      fetch: async () =>
        new Response(
          JSON.stringify(++n < 4 ? session({ status: "AWAITING_USER", updated_at: String(n), next_action: { type: "open_url", url: "https://anchor/kyc" } }) : session({ status: "FAILED" })),
          { status: 200 },
        ),
    });
    expect((await runner.start()).status).toBe("FAILED");
    expect(opened).toEqual(["https://anchor/kyc"]);
  });

  it("adapts Stellar Wallets Kit", async () => {
    const signer = stellarWalletsKitSigner({ signTransaction: async (xdr, o) => ({ signedTxXdr: `${xdr}|${o?.networkPassphrase}|${o?.address}` }) }, "GADDR");
    expect(await signer("X", { networkPassphrase: "P" })).toBe("X|P|GADDR");
  });
});
