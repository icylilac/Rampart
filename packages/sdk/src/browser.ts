import { RicercaError } from "./errors.js";
import { request, type FetchLike, type RequestOptions } from "./http.js";
import { TERMINAL_STATUSES, type NextAction, type RampSession } from "./types.js";

export * from "./types.js";
export { RicercaError } from "./errors.js";

/** Signs a transaction XDR in the user's wallet and returns the signed XDR. */
export type SignTransaction = (xdr: string, opts: { networkPassphrase: string }) => Promise<string>;

export type StripeOnrampOptions = {
  publishableKey: string;
  /** Element (or CSS selector) to mount Stripe's onramp widget into. */
  element: HTMLElement | string;
  appearance?: { theme?: "light" | "dark" };
  /** Override if Stripe changes its script URLs. */
  scriptUrls?: string[];
};

export type RampRunnerOptions = {
  sessionId: string;
  /** The session's client_secret (rcs_...), from your backend. Never your API key. */
  clientSecret: string;
  /** Your Ricerca Ramp deployment. Defaults to http://localhost:8080. */
  baseUrl?: string;
  /** Needed for off-ramps and anchors (sign_payment, sign_sep10_challenge). See stellarWalletsKitSigner. */
  signTransaction?: SignTransaction;
  /**
   * Opens a provider or anchor page. Defaults to a popup (window.open).
   * Browsers block popups that aren't started by a click, so you may want to
   * render a button instead.
   */
  openUrl?: (url: string, session: RampSession) => void | Promise<void>;
  /** Mounts Stripe's onramp widget for stripe_onramp actions. */
  stripe?: StripeOnrampOptions;
  /** Take over any action yourself. Return true if you handled it. */
  onAction?: (action: NextAction, session: RampSession) => boolean | Promise<boolean>;
  /** Called whenever the session changes. */
  onUpdate?: (session: RampSession) => void;
  pollIntervalMs?: number;
  fetch?: FetchLike;
};

const actionKey = (a: NextAction) =>
  a.type === "open_url" ? `url:${a.url}` : a.type === "stripe_onramp" ? `stripe:${a.client_secret}` : "xdr" in a ? `${a.type}:${a.xdr}` : a.type;

/**
 * Follows one ramp session in the browser and does each `next_action` for
 * you: opens the provider page, mounts Stripe's widget, or asks the wallet to
 * sign the SEP-10 challenge or payment and submits it. It authenticates with
 * the session's client secret, so your API key stays on your server.
 *
 *   const runner = new RampRunner({ sessionId, clientSecret, baseUrl, signTransaction, onUpdate });
 *   const final = await runner.start();   // resolves at COMPLETED / FAILED / EXPIRED / REFUNDED
 */
export class RampRunner {
  private readonly opts: RequestOptions;
  private readonly handled = new Set<string>();
  private stopped = false;
  private lastUpdatedAt: string | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly options: RampRunnerOptions) {
    this.opts = {
      baseUrl: options.baseUrl ?? "http://localhost:8080",
      token: options.clientSecret,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      timeoutMs: 30_000,
      maxRetries: 2,
    };
  }

  /** The session as the client secret sees it. */
  fetchSession(): Promise<RampSession> {
    return request(this.opts, "GET", `v1/client/sessions/${encodeURIComponent(this.options.sessionId)}`, { retry: true });
  }

  /** Runs until the session reaches a final status. Rejects if an action fails (e.g. the user declines to sign). */
  async start(): Promise<RampSession> {
    this.stopped = false;
    for (;;) {
      let session = await this.fetchSession();
      this.notify(session);
      if (TERMINAL_STATUSES.includes(session.status)) return session;
      if (this.stopped) return session;

      const action = session.next_action;
      if (action.type !== "none" && !this.handled.has(actionKey(action))) {
        const after = await this.perform(action, session);
        this.handled.add(actionKey(action));
        if (after) {
          session = after;
          this.notify(session);
          continue; // check the new state immediately
        }
      }
      await this.sleep(this.options.pollIntervalMs ?? 3000);
      if (this.stopped) return session;
    }
  }

  /** Stops polling; start() resolves with the latest session. */
  stop() {
    this.stopped = true;
    this.wake?.();
  }

  private notify(session: RampSession) {
    if (session.updated_at !== this.lastUpdatedAt) {
      this.lastUpdatedAt = session.updated_at;
      this.options.onUpdate?.(session);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  /** Does one action. Returns the updated session when the action changed it. */
  private async perform(action: NextAction, session: RampSession): Promise<RampSession | null> {
    if (this.options.onAction && (await this.options.onAction(action, session))) return null;
    const id = encodeURIComponent(session.id);
    switch (action.type) {
      case "open_url":
        if (this.options.openUrl) await this.options.openUrl(action.url, session);
        else if (typeof window !== "undefined") window.open(action.url, "_blank", "noopener,width=480,height=720");
        else throw new RicercaError("No openUrl handler and no window to open the provider page.", "no_open_url_handler", 0);
        return null;
      case "stripe_onramp":
        if (!this.options.stripe) {
          throw new RicercaError("Pass `stripe` options to mount Stripe's onramp widget.", "no_stripe_options", 0);
        }
        await mountStripeOnramp({ ...this.options.stripe, clientSecret: action.client_secret });
        return null;
      case "sign_sep10_challenge": {
        const signed = await this.sign(action.xdr, action.network_passphrase);
        return request(this.opts, "POST", `v1/client/sessions/${id}/anchor/auth`, { body: { signed_xdr: signed } });
      }
      case "sign_payment": {
        const signed = await this.sign(action.xdr, action.network_passphrase);
        return request(this.opts, "POST", `v1/client/sessions/${id}/transactions`, { body: { signed_xdr: signed } });
      }
      case "none":
        return null;
    }
  }

  private sign(xdr: string, networkPassphrase: string) {
    if (!this.options.signTransaction) {
      throw new RicercaError("This session needs a wallet signature; pass signTransaction.", "no_signer", 0);
    }
    return this.options.signTransaction(xdr, { networkPassphrase });
  }
}

/**
 * Adapts Stellar Wallets Kit (v1 instance or v2 static class) to
 * `signTransaction`. Freighter, xBull, Albedo and the other kit wallets work.
 */
export function stellarWalletsKitSigner(
  kit: { signTransaction(xdr: string, opts?: { networkPassphrase?: string; address?: string }): Promise<{ signedTxXdr: string }> },
  address?: string,
): SignTransaction {
  return async (xdr, { networkPassphrase }) => (await kit.signTransaction(xdr, { networkPassphrase, address })).signedTxXdr;
}

type StripeOnrampGlobal = (key: string) => {
  createSession(opts: { clientSecret: string; appearance?: unknown }): { mount(el: HTMLElement | string): void; addEventListener?: (type: string, cb: (e: unknown) => void) => void };
};

const DEFAULT_STRIPE_SCRIPTS = ["https://js.stripe.com/v3/", "https://crypto-js.stripe.com/crypto-onramp-outer.js"];

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new RicercaError(`Could not load ${src}.`, "script_load_failed", 0));
    document.head.appendChild(s);
  });
}

/** Loads Stripe's onramp scripts (once) and mounts the widget for a session. */
export async function mountStripeOnramp(opts: StripeOnrampOptions & { clientSecret: string }) {
  if (typeof window === "undefined") throw new RicercaError("Stripe's onramp widget needs a browser.", "no_window", 0);
  const w = window as unknown as { StripeOnramp?: StripeOnrampGlobal };
  if (!w.StripeOnramp) for (const src of opts.scriptUrls ?? DEFAULT_STRIPE_SCRIPTS) await loadScript(src);
  if (!w.StripeOnramp) throw new RicercaError("Stripe's onramp script did not load.", "script_load_failed", 0);
  const session = w.StripeOnramp(opts.publishableKey).createSession({ clientSecret: opts.clientSecret, appearance: opts.appearance });
  session.mount(opts.element);
  return session;
}
