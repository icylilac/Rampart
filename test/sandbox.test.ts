import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { plan, SCENARIOS, SandboxProvider } from "../src/providers/sandbox";
import type { SessionContext } from "../src/providers/types";

const RANK: Record<string, number> = { AWAITING_USER: 1, AWAITING_PAYMENT: 2, PROCESSING: 3, COMPLETED: 9, FAILED: 9, EXPIRED: 9, REFUNDED: 10 };

function fakeSession(scenario: string, direction: "ON" | "OFF", createdAt = new Date(0)): SessionContext {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    direction,
    status: "AWAITING_USER",
    createdAt,
    walletAddress: Keypair.random().publicKey(),
    assetCode: "USDC",
    assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    cryptoAmount: null,
    stellarTxHash: null,
    metadata: { sandbox: { scenario, offsetMs: 0 } },
    secrets: {},
  } as unknown as SessionContext;
}

describe("sandbox scenarios", () => {
  it.each(SCENARIOS.flatMap((s) => [[s, "ON"], [s, "OFF"]] as const))("%s (%s): the true state never goes backwards", (scenario, dir) => {
    const { pre, post } = plan(scenario, dir);
    for (const phase of [pre, post]) {
      const states = phase.filter((e) => e.state).map((e) => RANK[e.status]);
      expect(states).toEqual([...states].sort((a, b) => a - b));
    }
  });

  it("out_of_order_webhooks sends webhooks newest-first", () => {
    const hooks = plan("out_of_order_webhooks", "ON").pre.filter((e) => e.webhook).map((e) => e.status);
    expect(hooks[0]).toBe("COMPLETED");
    expect(hooks.at(-1)).toBe("AWAITING_PAYMENT");
  });

  it("missing_webhooks sends none", () => {
    const p = plan("missing_webhooks", "OFF");
    expect([...p.pre, ...p.post].some((e) => e.webhook)).toBe(false);
  });

  it("polls and advances on a virtual clock", async () => {
    const sbx = new SandboxProvider();
    const s = fakeSession("success", "ON");
    expect((await sbx.poll(s, 0))?.status).toBe("AWAITING_USER");
    const meta = sbx.advance(s, 0)!;
    const moved = { ...s, metadata: { sandbox: meta } } as SessionContext;
    expect((await sbx.poll(moved, 0))?.status).toBe("AWAITING_PAYMENT");
    expect(sbx.dueWebhooks(moved, 0).map((w) => w.update?.status)).toEqual(["AWAITING_PAYMENT"]);
  });

  it("off-ramp asks the wallet for an exact payment, then pauses", async () => {
    const sbx = new SandboxProvider();
    let s = fakeSession("success", "OFF");
    s = { ...s, metadata: { sandbox: sbx.advance(s, 0)! } } as SessionContext;
    const update = await sbx.poll(s, 0);
    expect(update?.status).toBe("AWAITING_PAYMENT");
    expect(update?.nextAction?.type).toBe("sign_payment");
    s = { ...s, status: "AWAITING_PAYMENT" } as SessionContext;
    expect(sbx.waitingForPayment(s)).toBe(true);
    expect(sbx.advance(s, 0)).toBeNull();
  });
});

describe("withdraw payment check", () => {
  it("reads a text memo parsed from XDR correctly", async () => {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const { checkWithdrawPayment } = await import("../src/providers/anchor");
    const { networkPassphrase } = await import("../src/stellar/network");
    const sbx = new SandboxProvider();
    const s = fakeSession("success", "OFF");
    const moved = { ...s, metadata: { sandbox: sbx.advance(s, 0)! } } as SessionContext;
    const update = (await sbx.poll(moved, 0))!;
    const tx = TransactionBuilder.fromXDR((update.nextAction as { xdr: string }).xdr, networkPassphrase()) as import("@stellar/stellar-sdk").Transaction;
    const withdraw = (update.metadata as { withdraw: { destination: string; amount: string; memo: string; memoType: string } }).withdraw;
    expect(checkWithdrawPayment(tx, { source: s.walletAddress, asset: { code: s.assetCode, issuer: s.assetIssuer }, ...withdraw })).toEqual([]);
    expect(checkWithdrawPayment(tx, { source: s.walletAddress, asset: { code: s.assetCode, issuer: s.assetIssuer }, ...withdraw, memo: "other" })).toHaveLength(1);
  });
});
