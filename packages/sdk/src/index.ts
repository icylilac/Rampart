import { createHmac, timingSafeEqual } from "node:crypto";
import { RicercaError, RicercaSignatureError } from "./errors.js";
import { request, type FetchLike, type RequestOptions } from "./http.js";
import {
  TERMINAL_STATUSES,
  type AdvanceResult,
  type CreateSessionParams,
  type List,
  type ListSessionsParams,
  type PreflightParams,
  type PreflightResult,
  type ProvidersResponse,
  type RampSession,
  type SessionEvents,
  type SessionStatus,
  type WebhookEvent,
} from "./types.js";

export * from "./types.js";
export { RicercaError, RicercaSignatureError } from "./errors.js";
export type { FetchLike } from "./http.js";

export type RicercaRampOptions = {
  /** Your Ricerca Ramp deployment, e.g. https://ramp.example.com. Defaults to http://localhost:8080. */
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
};

/**
 * Server-side client. Use it from your backend with a project API key
 * (rk_live_... or rk_test_...); never ship the key to a browser. For the
 * browser, pass the session's `client_secret` to `RampRunner` instead.
 *
 *   const ramp = new RicercaRamp(process.env.RICERCA_KEY!, { baseUrl: "https://ramp.example.com" });
 *   const session = await ramp.sessions.create({ direction: "ON", provider: "STRIPE", wallet_address, fiat_amount: 50 });
 */
export class RicercaRamp {
  /** true for rk_live_ keys, false for rk_test_ (sandbox) keys. */
  readonly livemode: boolean;
  private readonly opts: RequestOptions;

  constructor(apiKey: string, options: RicercaRampOptions = {}) {
    if (!/^rk_(live|test)_/.test(apiKey)) {
      throw new RicercaError("Expected a project API key starting with rk_live_ or rk_test_.", "invalid_api_key", 0);
    }
    this.livemode = apiKey.startsWith("rk_live_");
    this.opts = {
      baseUrl: options.baseUrl ?? "http://localhost:8080",
      token: apiKey,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
    };
  }

  /** Enabled providers, the network, and the test-mode scenarios. */
  providers(): Promise<ProvidersResponse> {
    return request(this.opts, "GET", "v1/providers", { retry: true });
  }

  /** Is the wallet ready (account, reserves, trustline)? Includes unsigned fix-up XDR. */
  preflight(params: PreflightParams): Promise<PreflightResult> {
    return request(this.opts, "POST", "v1/preflight", { body: params, retry: true });
  }

  readonly sessions = {
    /**
     * Starts a ramp. With `external_reference` the call is idempotent (safe to
     * retry); the session's `client_secret` is only returned the first time.
     */
    create: (params: CreateSessionParams): Promise<RampSession> =>
      request(this.opts, "POST", "v1/sessions", { body: params, retry: params.external_reference !== undefined }),

    retrieve: (id: string): Promise<RampSession> => request(this.opts, "GET", `v1/sessions/${encodeURIComponent(id)}`, { retry: true }),

    list: (params: ListSessionsParams = {}): Promise<List<RampSession>> =>
      request(this.opts, "GET", "v1/sessions", { query: params, retry: true }),

    /** Every session matching the filter, across pages: `for await (const s of ramp.sessions.listAll())`. */
    listAll: (params: ListSessionsParams = {}): AsyncGenerator<RampSession> => this.iterateSessions(params),

    /** Status history and the provider events received for the session. */
    events: (id: string): Promise<SessionEvents> =>
      request(this.opts, "GET", `v1/sessions/${encodeURIComponent(id)}/events`, { retry: true }),

    /** Ask the provider for the session's current state right now. */
    refresh: (id: string): Promise<RampSession> => request(this.opts, "POST", `v1/sessions/${encodeURIComponent(id)}/refresh`, { retry: true }),

    /** Submit the wallet-signed SEP-10 challenge (next_action: sign_sep10_challenge). */
    submitAnchorAuth: (id: string, signedXdr: string): Promise<RampSession> =>
      request(this.opts, "POST", `v1/sessions/${encodeURIComponent(id)}/anchor/auth`, { body: { signed_xdr: signedXdr } }),

    /** Submit the wallet-signed payment (next_action: sign_payment). */
    submitTransaction: (id: string, signedXdr: string): Promise<RampSession> =>
      request(this.opts, "POST", `v1/sessions/${encodeURIComponent(id)}/transactions`, { body: { signed_xdr: signedXdr } }),

    /** Polls until the session reaches one of `statuses` (default: any final status). */
    waitFor: async (
      id: string,
      options: { statuses?: SessionStatus[]; intervalMs?: number; timeoutMs?: number } = {},
    ): Promise<RampSession> => {
      const statuses = options.statuses ?? [...TERMINAL_STATUSES];
      const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
      for (;;) {
        const s = await this.sessions.retrieve(id);
        if (statuses.includes(s.status)) return s;
        if (Date.now() > deadline) throw new RicercaError(`Session ${id} is still ${s.status}.`, "wait_timeout", 0);
        await new Promise((r) => setTimeout(r, options.intervalMs ?? 2000));
      }
    },
  };

  private async *iterateSessions(params: ListSessionsParams): AsyncGenerator<RampSession> {
    let starting_after = params.starting_after;
    for (;;) {
      const page = await this.sessions.list({ ...params, starting_after });
      yield* page.data;
      if (!page.has_more || page.data.length === 0) return;
      starting_after = page.data[page.data.length - 1].id;
    }
  }

  /** Test mode helpers (rk_test_ keys only). */
  readonly sandbox = {
    /** Jump the session to its scenario's next step. */
    advance: (id: string): Promise<AdvanceResult> =>
      request(this.opts, "POST", `v1/sandbox/sessions/${encodeURIComponent(id)}/advance`),

    /**
     * Advance until nothing more happens: the scenario is finished, or an
     * off-ramp is waiting for the wallet's payment.
     */
    runToEnd: async (id: string, maxSteps = 25): Promise<AdvanceResult> => {
      for (let i = 0; i < maxSteps; i++) {
        const r = await this.sandbox.advance(id);
        if (!r.advanced) return r;
      }
      throw new RicercaError(`Sandbox session ${id} did not settle in ${maxSteps} steps.`, "sandbox_not_settled", 0);
    },
  };

  /** Verify webhooks Ricerca Ramp sends you. */
  static readonly webhooks = {
    /**
     * Checks the `Ricerca-Signature` header against the raw request body and
     * returns the parsed event. Throws RicercaSignatureError if it doesn't
     * match or is older than `toleranceSeconds`. Pass the raw body string,
     * not re-serialized JSON.
     */
    constructEvent(rawBody: string | Buffer, signatureHeader: string | null | undefined, secret: string, toleranceSeconds = 300, now = Date.now()): WebhookEvent {
      const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
      const parts = new Map<string, string[]>();
      for (const part of (signatureHeader ?? "").split(",")) {
        const i = part.indexOf("=");
        if (i > 0) parts.set(part.slice(0, i).trim(), [...(parts.get(part.slice(0, i).trim()) ?? []), part.slice(i + 1).trim()]);
      }
      const t = parts.get("t")?.[0];
      const signatures = parts.get("v1") ?? [];
      if (!t || signatures.length === 0) throw new RicercaSignatureError("Missing Ricerca-Signature header.");
      if (!/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > toleranceSeconds) {
        throw new RicercaSignatureError("Webhook timestamp is outside the tolerance window.");
      }
      const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
      const ok = signatures.some((s) => {
        const given = Buffer.from(s);
        return given.length === expected.length && timingSafeEqual(given, expected);
      });
      if (!ok) throw new RicercaSignatureError("Webhook signature does not match.");
      return JSON.parse(body) as WebhookEvent;
    },
  };
}
