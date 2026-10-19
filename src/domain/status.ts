import type { SessionStatus } from "@prisma/client";

/**
 * One lifecycle for every provider:
 *
 *   CREATED → AWAITING_USER → AWAITING_PAYMENT → PROCESSING → COMPLETED
 *                                                          ↘ FAILED | EXPIRED
 *   COMPLETED → REFUNDED (anchors can refund after completion)
 */
export const TERMINAL: ReadonlySet<SessionStatus> = new Set(["COMPLETED", "FAILED", "EXPIRED", "REFUNDED"]);

const RANK: Record<SessionStatus, number> = {
  CREATED: 0,
  AWAITING_USER: 1,
  AWAITING_PAYMENT: 2,
  PROCESSING: 3,
  COMPLETED: 9,
  FAILED: 9,
  EXPIRED: 9,
  REFUNDED: 10,
};

export type UpdateSource = "create" | "webhook" | "poll" | "submit" | "expire" | "auth";

/**
 * Whether a session may move from `from` to `to`.
 *
 * - Terminal states are final, except COMPLETED → REFUNDED.
 * - Webhooks can arrive out of order, so a webhook may not move a session
 *   backwards (e.g. a late "pending" after "processing"). A poll reads the
 *   provider's current state and may: some providers genuinely step back
 *   (a SEP-24 anchor asking the user for more information).
 */
/** True when `to` is earlier in the lifecycle than `from`. */
export function isBackward(from: SessionStatus, to: SessionStatus): boolean {
  return RANK[to] < RANK[from];
}

export function canTransition(from: SessionStatus, to: SessionStatus, source: UpdateSource): boolean {
  if (from === to) return false;
  if (TERMINAL.has(from)) return from === "COMPLETED" && to === "REFUNDED";
  if (source === "webhook" && RANK[to] < RANK[from]) return false;
  return true;
}

// ------------------------------------------------------------ mappings

/** Stripe Crypto Onramp session statuses. */
export function fromStripe(status: string): SessionStatus | null {
  switch (status) {
    case "initialized":
      return "AWAITING_USER";
    case "requires_payment":
      return "AWAITING_PAYMENT";
    case "fulfillment_processing":
      return "PROCESSING";
    case "fulfillment_complete":
      return "COMPLETED";
    case "rejected":
      return "FAILED";
    default:
      return null;
  }
}

/** MoonPay buy (`/v1/transactions`) and sell (`/v3/sell_transactions`) statuses. */
export function fromMoonpay(status: string): SessionStatus | null {
  switch (status) {
    case "waitingAuthorization":
      return "AWAITING_USER";
    case "waitingPayment":
    case "waitingForDeposit":
      return "AWAITING_PAYMENT";
    case "pending":
      return "PROCESSING";
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    default:
      return null;
  }
}

/** SEP-24 transaction statuses. */
export function fromSep24(status: string): SessionStatus | null {
  switch (status) {
    case "incomplete":
    case "pending_user":
    case "pending_trust":
    case "pending_customer_info_update":
      return "AWAITING_USER";
    case "pending_user_transfer_start":
      return "AWAITING_PAYMENT";
    case "pending_user_transfer_complete":
    case "pending_external":
    case "pending_anchor":
    case "pending_stellar":
      return "PROCESSING";
    case "completed":
      return "COMPLETED";
    case "refunded":
      return "REFUNDED";
    case "expired":
      return "EXPIRED";
    case "no_market":
    case "too_small":
    case "too_large":
    case "error":
      return "FAILED";
    default:
      return null;
  }
}
