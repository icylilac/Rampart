/** Mirrors the Rampart API objects (snake_case, amounts as decimal strings). */

export type Direction = "ON" | "OFF";
export type Provider = "STRIPE" | "MOONPAY" | "ANCHOR" | "SANDBOX";
export type SessionStatus =
  | "CREATED"
  | "AWAITING_USER"
  | "AWAITING_PAYMENT"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "EXPIRED"
  | "REFUNDED";

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["COMPLETED", "FAILED", "EXPIRED", "REFUNDED"];

export const SANDBOX_SCENARIOS = [
  "success",
  "missing_webhooks",
  "out_of_order_webhooks",
  "late_webhook",
  "completed_not_delivered",
  "kyc_rejected",
  "expired",
  "refunded",
] as const;
export type SandboxScenario = (typeof SANDBOX_SCENARIOS)[number];

export type Asset = { code: string; issuer: string | null };

/** What the user or wallet must do next. */
export type NextAction =
  | { type: "open_url"; url: string }
  | { type: "stripe_onramp"; client_secret: string; stripe_session_id: string }
  | { type: "sign_sep10_challenge"; xdr: string; network_passphrase: string }
  | {
      type: "sign_payment";
      xdr: string;
      network_passphrase: string;
      destination: string;
      amount: string;
      asset: Asset;
      memo: string | null;
      memo_type: string | null;
    }
  | { type: "none" };

export type OnchainCheck = {
  verified: boolean;
  reason: string;
  txHash: string;
  ledger?: number;
  deliveredAmount?: string;
  memo?: string | null;
  simulated?: boolean;
};

/**
 * A delivery's receipt in the ramp-receipts contract. Look it up on Stellar
 * with the contract's `get(receipt_id)` to check it without trusting the service.
 */
export type OnchainReceipt = {
  contract_id: string;
  /** SHA-256 of the session id, hex: the key the contract stores it under. */
  receipt_id: string;
  status: "DELIVERED" | "REFUNDED";
  /** The Stellar transaction that recorded it (null if another worker recorded it). */
  tx_hash: string | null;
  recorded_at: string | null;
  refunded_at: string | null;
};

export type RampSession = {
  id: string;
  object: "ramp_session";
  livemode: boolean;
  direction: Direction;
  provider: Provider;
  status: SessionStatus;
  provider_status: string | null;
  wallet_address: string;
  asset: Asset;
  fiat_currency: string | null;
  fiat_amount: string | null;
  crypto_amount: string | null;
  external_reference: string | null;
  anchor_domain: string | null;
  next_action: NextAction;
  stellar_tx_hash: string | null;
  onchain_verified: boolean | null;
  onchain_check: OnchainCheck | null;
  failure_reason: string | null;
  /** The delivery's on-chain receipt, once recorded (live sessions, when the service has receipts on). */
  receipt: OnchainReceipt | null;
  sandbox?: { scenario: SandboxScenario; simulating: Provider | null };
  expires_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Only on the response that created the session. Give it to the browser. */
  client_secret?: string;
};

export type CreateSessionParams = {
  direction: Direction;
  /** Required with a live key. With a test key it is optional and only recorded. */
  provider?: Provider;
  wallet_address: string;
  /** "USDC" (default) or "XLM". */
  asset?: string;
  fiat_currency?: string;
  fiat_amount?: number | string;
  crypto_amount?: number | string;
  /** Your own id for this ramp. Sending the same one again returns the same session. */
  external_reference?: string;
  anchor_domain?: string;
  redirect_url?: string;
  customer_ip?: string;
  lang?: string;
  /** Test mode only. */
  sandbox_scenario?: SandboxScenario;
  skip_preflight?: boolean;
};

export type ListSessionsParams = {
  status?: SessionStatus;
  provider?: Provider;
  wallet_address?: string;
  external_reference?: string;
  limit?: number;
  starting_after?: string;
};

export type List<T> = { object: "list"; data: T[]; has_more: boolean };

export type SessionEvents = {
  object: "list";
  status_changes: { object: "status_change"; from: SessionStatus; to: SessionStatus; source: string; detail: string | null; at: string }[];
  provider_events: { object: "provider_event"; id: string; type: string; received_at: string }[];
};

export type PreflightParams = {
  wallet_address: string;
  asset?: string;
  direction?: Direction;
  crypto_amount?: number | string;
};

export type PreflightIssue =
  | { code: "account_not_found"; message: string }
  | { code: "insufficient_xlm"; message: string; available: string; required: string }
  | { code: "missing_trustline"; message: string; xdr: string }
  | { code: "trustline_not_authorized"; message: string }
  | { code: "trustline_limit"; message: string; room: string }
  | { code: "insufficient_balance"; message: string; available: string };

export type PreflightResult = {
  ready: boolean;
  wallet: string;
  asset: Asset;
  xlm: { balance: string; minimum: string; spendable: string } | null;
  assetBalance: string | null;
  issues: PreflightIssue[];
};

export type ProviderCapabilities = {
  provider: Provider;
  enabled: boolean;
  directions: Direction[];
  assets: string[];
  fiat: string[];
  notes?: string;
};

export type ProvidersResponse = {
  network: "TESTNET" | "PUBLIC";
  usdc: Asset;
  providers: ProviderCapabilities[];
  test_mode: ProviderCapabilities & { scenarios: { id: SandboxScenario; description: string }[] };
};

export type AdvanceResult = { advanced: boolean; reason: "waiting_for_payment" | "scenario_finished" | null; session: RampSession };

/** The event Rampart POSTs to your webhook endpoint. */
export type WebhookEvent = {
  id: string;
  object: "event";
  type: "ramp_session.updated";
  created: number;
  livemode: boolean;
  data: { object: RampSession };
};
