import type { Direction, Provider, RampSession, SessionStatus } from "@prisma/client";
import type { AssetRef } from "../stellar/network";

/** What the end user or wallet must do next. Returned to the project as `next_action`. */
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
      asset: AssetRef;
      memo: string | null;
      memo_type: string | null;
    }
  | { type: "none" };

export type CreateInput = {
  sessionId: string;
  direction: Direction;
  wallet: string;
  asset: AssetRef;
  fiatCurrency?: string;
  fiatAmount?: number;
  cryptoAmount?: number;
  redirectUrl?: string;
  customerIp?: string;
  anchorDomain?: string;
  lang?: string;
};

/** A normalized view of the provider's state. Undefined fields mean "unchanged". */
export type StatusUpdate = {
  status: SessionStatus;
  providerStatus: string;
  providerRef?: string;
  stellarTxHash?: string | null;
  fiatAmount?: number | null;
  cryptoAmount?: number | null;
  failureReason?: string | null;
  nextAction?: NextAction;
  metadata?: Record<string, unknown>;
  secrets?: Record<string, string>;
};

export type CreateResult = StatusUpdate & { nextAction: NextAction };

export type ParsedWebhook = {
  eventId: string;
  type: string;
  /** How to find the session: our id (preferred) or the provider's reference. */
  sessionId?: string;
  providerRef?: string;
  update?: StatusUpdate;
};

export type Capabilities = {
  provider: Provider;
  enabled: boolean;
  directions: Direction[];
  assets: string[];
  fiat: string[];
  notes?: string;
};

export type SessionContext = RampSession & { secrets: Record<string, string> };

export interface RampProvider {
  readonly id: Provider;
  capabilities(): Capabilities;
  create(input: CreateInput): Promise<CreateResult>;
  /** Current state from the provider (source of truth for the reconciler). */
  poll(session: SessionContext): Promise<StatusUpdate | null>;
  /** Verify and parse an inbound webhook. Throws on a bad signature. */
  parseWebhook?(rawBody: string, headers: Record<string, string | string[] | undefined>): ParsedWebhook | null;
}

export class WebhookSignatureError extends Error {}
