import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { resetConfig } from "../src/config";
import { syncReceipts } from "../src/engine/receipts";
import { encrypt } from "../src/lib/crypto";
import { db } from "../src/lib/db";
import { newApiKey } from "../src/lib/keys";
import { usdc } from "../src/stellar/network";
import {
  type OnchainReceipt,
  ReceiptContractError,
  type ReceiptInput,
  type ReceiptsClient,
  assetContractId,
  fromStroops,
  parseReceipt,
  receiptId,
  recordArgs,
  setReceiptsClient,
  toStroops,
} from "../src/stellar/receipts";

const CONTRACT = "CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ";
const txHash = (n: number) => n.toString(16).padStart(64, "0");

describe("receipt encoding", () => {
  it("converts amounts to and from stroops", () => {
    expect(toStroops("25.5")).toBe(255_000_000n);
    expect(toStroops("0.0000001")).toBe(1n);
    expect(toStroops("100")).toBe(1_000_000_000n);
    expect(fromStroops(255_000_000n)).toBe("25.5");
    expect(fromStroops(1_000_000_000n)).toBe("100");
    for (const bad of ["0", "-1", "1.00000001", "abc", ""]) expect(() => toStroops(bad)).toThrow();
  });

  it("keys a receipt by the SHA-256 of the session id", () => {
    expect(receiptId("abc").toString("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("builds record's arguments in the contract's order and types", () => {
    const attester = Keypair.random().publicKey();
    const wallet = Keypair.random().publicKey();
    const args = recordArgs(attester, {
      sessionId: "s1",
      wallet,
      direction: "OFF",
      provider: "ANCHOR",
      asset: usdc(),
      amount: "12.25",
      txHash: txHash(7),
    });
    expect(args.map((a) => scValToNative(a))).toEqual([
      attester,
      receiptId("s1"),
      wallet,
      ["Off"],
      "ANCHOR",
      assetContractId(usdc()),
      122_500_000n,
      Buffer.from(txHash(7), "hex"),
    ]);
    expect(assetContractId(usdc())).toMatch(/^C[A-Z2-7]{55}$/);
    const valid = { sessionId: "s", wallet, direction: "ON" as const, provider: "STRIPE", asset: usdc(), amount: "1", txHash: txHash(1) };
    expect(() => recordArgs(attester, { ...valid, txHash: "nope" })).toThrow(/transaction hash/);
    expect(() => recordArgs(attester, { ...valid, amount: "0" })).toThrow(/positive/);
  });

  it("reads a receipt as the contract returns it", () => {
    const raw = {
      attester: "GATTESTER",
      wallet: "GWALLET",
      direction: ["On"] as ["On"],
      provider: "STRIPE",
      asset: "CASSET",
      amount: 250_000_000n,
      tx_hash: Buffer.from(txHash(1), "hex"),
      status: ["Refunded", Buffer.from(txHash(2), "hex")] as ["Refunded", Buffer],
      recorded_at: 1_760_000_000n,
    };
    expect(parseReceipt(raw)).toEqual({
      attester: "GATTESTER",
      wallet: "GWALLET",
      direction: "ON",
      provider: "STRIPE",
      asset: "CASSET",
      amount: "25",
      txHash: txHash(1),
      status: "REFUNDED",
      refundTxHash: txHash(2),
      recordedAt: new Date(1_760_000_000_000),
    });
    expect(parseReceipt({ ...raw, status: ["Delivered"] }).status).toBe("DELIVERED");
  });
});

/** Behaves like the contract: one receipt per session, one session per delivery tx. */
class FakeReceipts implements ReceiptsClient {
  readonly contractId = CONTRACT;
  receipts = new Map<string, OnchainReceipt>();
  txs = new Set<string>();
  calls: string[] = [];
  failNext: Error | null = null;

  async get(sessionId: string) {
    return this.receipts.get(sessionId) ?? null;
  }
  async record(input: ReceiptInput) {
    this.calls.push(`record ${input.sessionId} ${input.amount}`);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    if (this.receipts.has(input.sessionId)) throw new ReceiptContractError(2, "already_recorded");
    if (this.txs.has(input.txHash)) throw new ReceiptContractError(3, "tx_already_used");
    this.txs.add(input.txHash);
    this.receipts.set(input.sessionId, {
      wallet: input.wallet,
      direction: input.direction,
      provider: input.provider,
      asset: assetContractId(input.asset),
      amount: input.amount,
      txHash: input.txHash,
      status: "DELIVERED",
      refundTxHash: null,
      recordedAt: new Date(),
      attester: "GATTESTER",
    });
    return txHash(1000 + this.calls.length);
  }
  async markRefunded(sessionId: string) {
    this.calls.push(`refund ${sessionId}`);
    const r = this.receipts.get(sessionId);
    if (!r) throw new ReceiptContractError(4, "not_found");
    if (r.status === "REFUNDED") throw new ReceiptContractError(5, "already_refunded");
    r.status = "REFUNDED";
    return txHash(2000 + this.calls.length);
  }
}

describe("on-chain receipts (reconciler)", () => {
  let app: FastifyInstance;
  let projectId: string;
  let liveKey: string;
  let fake: FakeReceipts;
  const log = () => {};
  let n = 0;

  async function session(overrides: Record<string, unknown> = {}) {
    n++;
    return db().rampSession.create({
      data: {
        projectId,
        livemode: true,
        direction: "ON",
        provider: "STRIPE",
        status: "COMPLETED",
        walletAddress: Keypair.random().publicKey(),
        assetCode: "USDC",
        assetIssuer: usdc().issuer,
        cryptoAmount: "25",
        stellarTxHash: txHash(n),
        onchainVerified: true,
        onchainCheck: { verified: true, reason: "ok", txHash: txHash(n), deliveredAmount: "25.5000000" },
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        ...overrides,
      },
    });
  }
  const reload = (id: string) => db().rampSession.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    process.env.RECEIPTS_CONTRACT_ID = CONTRACT;
    process.env.RECEIPTS_ATTESTER_SECRET = Keypair.random().secret();
    resetConfig();
    app = buildServer();
    const live = newApiKey("LIVE");
    liveKey = live.key;
    const project = await db().project.create({
      data: { name: "Receipts project", webhookSecretEnc: encrypt("whsec_receipts"), apiKeys: { create: [{ mode: "LIVE", keyHash: live.hash, prefix: live.prefix }] } },
    });
    projectId = project.id;
  });

  beforeEach(async () => {
    fake = new FakeReceipts();
    setReceiptsClient(fake);
    // Earlier tests' sessions shouldn't be picked up.
    await db().rampSession.updateMany({ where: { projectId }, data: { receiptError: "test reset" } });
  });

  afterAll(async () => {
    setReceiptsClient(undefined);
    delete process.env.RECEIPTS_CONTRACT_ID;
    delete process.env.RECEIPTS_ATTESTER_SECRET;
    resetConfig();
    await app.close();
  });

  it("records a verified live delivery with the amount Horizon saw, and shows it in the API", async () => {
    const s = await session();
    await syncReceipts(log, fake);
    expect(fake.calls).toEqual([`record ${s.id} 25.5000000`]);
    const after = await reload(s.id);
    expect(after.receiptRecordedAt).not.toBeNull();
    expect(after.receiptTxHash).toBe(txHash(1001));

    const res = await app.inject({ method: "GET", url: `/v1/sessions/${s.id}`, headers: { authorization: `Bearer ${liveKey}` } });
    expect(res.json().receipt).toEqual({
      contract_id: CONTRACT,
      receipt_id: receiptId(s.id).toString("hex"),
      status: "DELIVERED",
      tx_hash: txHash(1001),
      recorded_at: after.receiptRecordedAt!.toISOString(),
      refunded_at: null,
    });

    // Nothing left to do on the next pass.
    await syncReceipts(log, fake);
    expect(fake.calls).toHaveLength(1);
  });

  it("skips test-mode, unverified and not-yet-completed sessions", async () => {
    await session({ livemode: false });
    await session({ onchainVerified: null });
    await session({ onchainVerified: false });
    await session({ status: "PROCESSING", completedAt: null });
    await syncReceipts(log, fake);
    expect(fake.calls).toEqual([]);
  });

  it("does nothing when receipts aren't configured", async () => {
    const s = await session();
    await syncReceipts(log, null);
    expect((await reload(s.id)).receiptRecordedAt).toBeNull();
  });

  it("adopts a receipt that's already on-chain instead of writing it twice", async () => {
    const s = await session();
    await fake.record({ sessionId: s.id, wallet: s.walletAddress, direction: "ON", provider: "STRIPE", asset: usdc(), amount: "25.5", txHash: s.stellarTxHash! });
    fake.calls = [];
    await syncReceipts(log, fake);
    expect(fake.calls).toEqual([]);
    expect((await reload(s.id)).receiptRecordedAt).not.toBeNull();
  });

  it("stops retrying when the delivery tx already backs another session", async () => {
    const first = await session();
    const second = await session({ stellarTxHash: first.stellarTxHash });
    await syncReceipts(log, fake);
    expect((await reload(first.id)).receiptRecordedAt).not.toBeNull();
    const dup = await reload(second.id);
    expect(dup.receiptRecordedAt).toBeNull();
    expect(dup.receiptError).toBe("tx_already_used");
    fake.calls = [];
    await syncReceipts(log, fake);
    expect(fake.calls).toEqual([]);
  });

  it("retries after a network error", async () => {
    const s = await session();
    fake.failNext = new Error("RPC 502");
    const errors: string[] = [];
    await syncReceipts((m) => errors.push(m), fake);
    expect(errors).toEqual([`receipt ${s.id} failed`]);
    expect((await reload(s.id)).receiptRecordedAt).toBeNull();
    await syncReceipts(log, fake);
    expect((await reload(s.id)).receiptRecordedAt).not.toBeNull();
  });

  it("marks the receipt refunded when the session is refunded", async () => {
    const s = await session();
    await syncReceipts(log, fake);
    await db().rampSession.update({ where: { id: s.id }, data: { status: "REFUNDED" } });
    await syncReceipts(log, fake);
    expect(fake.calls).toEqual([`record ${s.id} 25.5000000`, `refund ${s.id}`]);
    expect(fake.receipts.get(s.id)?.status).toBe("REFUNDED");
    const res = await app.inject({ method: "GET", url: `/v1/sessions/${s.id}`, headers: { authorization: `Bearer ${liveKey}` } });
    expect(res.json().receipt.status).toBe("REFUNDED");
    await syncReceipts(log, fake);
    expect(fake.calls).toHaveLength(2);
  });

  it("records and refunds a session that was refunded before its receipt was written", async () => {
    const s = await session({ status: "REFUNDED" });
    await syncReceipts(log, fake);
    expect(fake.calls).toEqual([`record ${s.id} 25.5000000`, `refund ${s.id}`]);
  });
});
