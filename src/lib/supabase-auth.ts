import { config } from "../config";
import { ApiError } from "./errors";

/**
 * Supabase Auth signs people in (email + password, Google, GitHub, ...) and
 * gives the browser an access token. Asking Supabase who that token belongs
 * to is the check: it fails for an expired, revoked or forged token.
 */

export type SupabaseUser = { id: string; email: string };

type AppMetadata = { provider?: string; wallet_address?: string };
type UserResponse = { id?: string; email?: string | null; email_confirmed_at?: string | null; app_metadata?: AppMetadata };

/**
 * Only the server, with the service-role key, can set app_metadata. A user on
 * the wallet email domain without it was signed up by someone else to squat
 * on a wallet's placeholder address.
 */
function serverMadeWalletUser(meta: AppMetadata | undefined, address?: string): boolean {
  if (meta?.provider !== "stellar" || typeof meta.wallet_address !== "string") return false;
  return address === undefined || meta.wallet_address === address;
}

function isWalletEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${config().WALLET_EMAIL_DOMAIN.toLowerCase()}`);
}

export async function supabaseUser(accessToken: string): Promise<SupabaseUser> {
  const cfg = config();
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    throw new ApiError(503, "auth_unavailable", "Email sign-in isn't set up on this server.");
  }
  let res: Response;
  try {
    res = await fetch(`${cfg.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(502, "auth_upstream", "Couldn't reach the sign-in service. Try again.");
  }
  if (res.status >= 400 && res.status < 500) throw new ApiError(401, "invalid_login", "Your sign-in expired. Sign in again.");
  if (!res.ok) throw new ApiError(502, "auth_upstream", "The sign-in service had a problem. Try again.");
  const user = (await res.json().catch(() => ({}))) as UserResponse;
  if (!user.id) throw new ApiError(401, "invalid_login", "Your sign-in expired. Sign in again.");
  if (!user.email || !user.email_confirmed_at) {
    throw new ApiError(403, "email_unconfirmed", "Confirm your email address first, using the link we sent you.");
  }
  if (isWalletEmail(user.email) && !serverMadeWalletUser(user.app_metadata)) {
    throw new ApiError(403, "invalid_login", "This email address is reserved. Sign in with your wallet instead.");
  }
  return { id: user.id, email: user.email.toLowerCase() };
}

type AdminUser = { id?: string; email?: string; app_metadata?: AppMetadata };

/**
 * The Supabase Auth user standing for a Stellar wallet, created on first use
 * with the server's service-role key. Supabase Auth has no Stellar sign-in, so
 * it gets a placeholder email (G...@<WALLET_EMAIL_DOMAIN>, confirmed, never
 * mailed) and the address in its metadata. Null when the key isn't set.
 */
export async function walletAuthUserId(address: string): Promise<string | null> {
  const cfg = config();
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) return null;
  const base = `${cfg.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/admin/users`;
  const headers = { apikey: cfg.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${cfg.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
  const email = `${address.toLowerCase()}@${cfg.WALLET_EMAIL_DOMAIN}`;
  const created = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      email_confirm: true,
      app_metadata: { provider: "stellar", providers: ["stellar"], wallet_address: address },
      user_metadata: { wallet_address: address },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (created.ok) {
    const user = (await created.json()) as AdminUser;
    if (user.id) return user.id;
  }
  // Already there (an earlier sign-in that didn't finish linking): find it.
  if (created.status === 422) {
    const found = await fetch(`${base}?filter=${encodeURIComponent(email)}&per_page=10`, { headers, signal: AbortSignal.timeout(10_000) });
    if (found.ok) {
      const { users = [] } = (await found.json()) as { users?: AdminUser[] };
      const user = users.find((u) => u.email === email);
      if (user?.id && serverMadeWalletUser(user.app_metadata, address)) return user.id;
      if (user?.id) throw new Error(`Supabase user ${user.id} has wallet ${address}'s placeholder email but wasn't made by Rampart; refusing to link it`);
    }
  }
  throw new Error(`Supabase admin returned ${created.status}`);
}
