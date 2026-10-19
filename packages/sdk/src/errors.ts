/** An error returned by the Ricerca Ramp API, or a failure to reach it. */
export class RicercaError extends Error {
  readonly name = "RicercaError";
  constructor(
    message: string,
    /** Stable machine-readable code, e.g. "preflight_failed", "idempotency_conflict". */
    readonly code: string,
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number,
    /** Extra detail from the API (e.g. the pre-flight issues and fix-up XDR). */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** A webhook whose signature or timestamp didn't check out. Respond 400. */
export class RicercaSignatureError extends Error {
  readonly name = "RicercaSignatureError";
}
