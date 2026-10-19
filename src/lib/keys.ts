import { randomToken, sha256Hex } from "./crypto";

/** Project API keys: rk_live_... reach real providers, rk_test_... only the sandbox. */
export type KeyMode = "LIVE" | "TEST";

export function newApiKey(mode: KeyMode): { key: string; hash: string; prefix: string } {
  const key = `rk_${mode === "LIVE" ? "live" : "test"}_${randomToken(24)}`;
  return { key, hash: sha256Hex(key), prefix: key.slice(0, 12) };
}

/** A per-session secret a browser can hold: it can read and act on that one session only. */
export function newClientSecret(): { secret: string; hash: string } {
  const secret = `rcs_${randomToken(24)}`;
  return { secret, hash: sha256Hex(secret) };
}

/** Secret a project uses to verify the webhooks Ricerca Ramp sends it. */
export const newWebhookSecret = () => `whsec_${randomToken(32)}`;

export const isApiKey = (v: string) => /^rk_(live|test)_[A-Za-z0-9_-]{20,}$/.test(v);
export const isClientSecret = (v: string) => /^rcs_[A-Za-z0-9_-]{20,}$/.test(v);
