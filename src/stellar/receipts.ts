import { createHash } from "node:crypto";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "../config";
import { type AssetRef, networkPassphrase, toSdkAsset } from "./network";

/**
 * Client for the ramp-receipts contract (contracts/ramp-receipts): a public
 * record of verified deliveries. The attester key is both the transaction
 * source and the address the contract checks, so one signature covers both.
 */

export type ReceiptInput = {
  sessionId: string;
  wallet: string;
  direction: "ON" | "OFF";
  provider: string;
  asset: AssetRef;
  /** Decimal string with up to 7 decimals, e.g. "25.5". */
  amount: string;
  txHash: string;
};

export type OnchainReceipt = {
  wallet: string;
  direction: "ON" | "OFF";
  provider: string;
  asset: string;
  amount: string;
  txHash: string;
  status: "DELIVERED" | "REFUNDED";
  refundTxHash: string | null;
  recordedAt: Date;
  attester: string;
};

export interface ReceiptsClient {
  readonly contractId: string;
  get(sessionId: string): Promise<OnchainReceipt | null>;
  /** Returns the hash of the Stellar transaction that recorded the receipt. */
  record(input: ReceiptInput): Promise<string>;
  markRefunded(sessionId: string, refundTxHash: string | null): Promise<string>;
}

/** A contract error the call can't recover from by retrying (the contract's `Error` enum). */
export class ReceiptContractError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(`ramp-receipts error #${code} (${reason})`);
  }
}

const CONTRACT_ERRORS: Record<number, string> = {
  1: "not_attester",
  2: "already_recorded",
  3: "tx_already_used",
  4: "not_found",
  5: "already_refunded",
  6: "invalid_amount",
};

/** The receipt id the contract stores a session under: SHA-256 of the session id. */
export function receiptId(sessionId: string): Buffer {
  return createHash("sha256").update(sessionId, "utf8").digest();
}

/** "25.5" -> 255000000n (7 decimals). Rejects anything that isn't a positive amount. */
export function toStroops(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Not a Stellar amount: ${amount}`);
  const stroops = BigInt(m[1]) * 10_000_000n + BigInt((m[2] ?? "").padEnd(7, "0"));
  if (stroops <= 0n) throw new Error(`Amount must be positive: ${amount}`);
  return stroops;
}

export function fromStroops(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** The Stellar Asset Contract address the contract identifies an asset by. */
export function assetContractId(asset: AssetRef): string {
  return toSdkAsset(asset).contractId(networkPassphrase());
}

const bytes32 = (hex: string) => {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`Not a transaction hash: ${hex}`);
  return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
};
const unitEnum = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);

/** The arguments of `record`, in the contract's order. */
export function recordArgs(attester: string, input: ReceiptInput): xdr.ScVal[] {
  return [
    new Address(attester).toScVal(),
    xdr.ScVal.scvBytes(receiptId(input.sessionId)),
    new Address(input.wallet).toScVal(),
    unitEnum(input.direction === "ON" ? "On" : "Off"),
    xdr.ScVal.scvSymbol(input.provider),
    new Address(assetContractId(input.asset)).toScVal(),
    nativeToScVal(toStroops(input.amount), { type: "i128" }),
    bytes32(input.txHash),
  ];
}

type RawReceipt = {
  attester: string;
  wallet: string;
  direction: ["On"] | ["Off"];
  provider: string;
  asset: string;
  amount: bigint;
  tx_hash: Buffer;
  status: ["Delivered"] | ["Refunded", Buffer | undefined | null];
  recorded_at: bigint;
};

export function parseReceipt(raw: RawReceipt): OnchainReceipt {
  const refunded = raw.status[0] === "Refunded";
  const refundTx = refunded ? (raw.status[1] as Buffer | undefined | null) : null;
  return {
    wallet: raw.wallet,
    direction: raw.direction[0] === "On" ? "ON" : "OFF",
    provider: raw.provider,
    asset: raw.asset,
    amount: fromStroops(BigInt(raw.amount)),
    txHash: Buffer.from(raw.tx_hash).toString("hex"),
    status: refunded ? "REFUNDED" : "DELIVERED",
    refundTxHash: refundTx ? Buffer.from(refundTx).toString("hex") : null,
    recordedAt: new Date(Number(raw.recorded_at) * 1000),
    attester: raw.attester,
  };
}

function contractError(message: string): ReceiptContractError | null {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  if (!m) return null;
  const code = Number(m[1]);
  return new ReceiptContractError(code, CONTRACT_ERRORS[code] ?? "unknown");
}

export function sorobanRpcUrl(): string {
  const cfg = config();
  return cfg.SOROBAN_RPC_URL ?? (cfg.STELLAR_NETWORK === "PUBLIC" ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org");
}

/** Reads simulate from this all-zero account, as the Stellar SDK does, so they need no key. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Reads a receipt from the contract. Needs no key: anyone can check a delivery. */
export async function readReceipt(
  contractId: string,
  sessionId: string,
  net: { rpcUrl?: string; passphrase?: string } = {},
): Promise<OnchainReceipt | null> {
  const server = new rpc.Server(net.rpcUrl ?? sorobanRpcUrl());
  const passphrase = net.passphrase ?? networkPassphrase();
  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call("get", xdr.ScVal.scvBytes(receiptId(sessionId))))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulate get: ${sim.error}`);
  const value = sim.result ? scValToNative(sim.result.retval) : null;
  return value ? parseReceipt(value as RawReceipt) : null;
}

/** The real client, over Soroban RPC. */
export function sorobanReceiptsClient(opts: { contractId: string; attesterSecret: string; rpcUrl?: string }): ReceiptsClient {
  const rpcUrl = opts.rpcUrl ?? sorobanRpcUrl();
  const server = new rpc.Server(rpcUrl);
  const attester = Keypair.fromSecret(opts.attesterSecret);
  const contract = new Contract(opts.contractId);
  const passphrase = networkPassphrase();

  const build = async (method: string, args: xdr.ScVal[]) =>
    new TransactionBuilder(await server.getAccount(attester.publicKey()), { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build();

  async function invoke(method: string, args: xdr.ScVal[]): Promise<string> {
    const raw = await build(method, args);
    const sim = await server.simulateTransaction(raw);
    if (rpc.Api.isSimulationError(sim)) throw contractError(sim.error) ?? new Error(`simulate ${method}: ${sim.error}`);
    const tx = rpc.assembleTransaction(raw, sim).build();
    tx.sign(attester);
    const sent = await server.sendTransaction(tx);
    if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
      throw new Error(`send ${method}: ${sent.status} ${sent.errorResult?.toXDR("base64") ?? ""}`);
    }
    const done = await server.pollTransaction(sent.hash, { attempts: 30 });
    if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${method} transaction ${sent.hash}: ${done.status}`);
    return sent.hash;
  }

  return {
    contractId: opts.contractId,
    get: (sessionId) => readReceipt(opts.contractId, sessionId, { rpcUrl, passphrase }),
    record: (input) => invoke("record", recordArgs(attester.publicKey(), input)),
    markRefunded: (sessionId, refundTxHash) =>
      invoke("mark_refunded", [
        new Address(attester.publicKey()).toScVal(),
        xdr.ScVal.scvBytes(receiptId(sessionId)),
        refundTxHash ? bytes32(refundTxHash) : xdr.ScVal.scvVoid(),
      ]),
  };
}

let override: ReceiptsClient | null | undefined;

/** The configured client, or null when receipts are off. */
export function receiptsClient(): ReceiptsClient | null {
  if (override !== undefined) return override;
  const cfg = config();
  if (!cfg.RECEIPTS_CONTRACT_ID || !cfg.RECEIPTS_ATTESTER_SECRET) return null;
  override = sorobanReceiptsClient({ contractId: cfg.RECEIPTS_CONTRACT_ID, attesterSecret: cfg.RECEIPTS_ATTESTER_SECRET });
  return override;
}

/** For tests: use a fake client (or null to turn receipts off). */
export function setReceiptsClient(client: ReceiptsClient | null | undefined) {
  override = client;
}
