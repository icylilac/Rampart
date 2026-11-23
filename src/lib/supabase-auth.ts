import { config } from "../config";
import { ApiError } from "./errors";

/**
 * Supabase Auth runs the Google/GitHub/... sign-in and hands the browser a
 * one-time PKCE code. Trading the code (with the verifier only that browser
 * has) for a Supabase session gives us the provider-confirmed email. Supabase
 * Auth's own session is then dropped: the dashboard uses Rampart's rds_ token.
 */

export type OAuthIdentity = { email: string; provider: string };

type SupabaseSession = {
  user?: { email?: string | null; email_confirmed_at?: string | null; app_metadata?: { provider?: string } };
};

const failed = () => new ApiError(401, "oauth_failed", "That sign-in didn't go through. Try again.");

export async function exchangeOAuthCode(code: string, codeVerifier: string): Promise<OAuthIdentity> {
  const cfg = config();
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    throw new ApiError(503, "oauth_unavailable", "Sign-in with Google or GitHub isn't set up on this server.");
  }
  let res: Response;
  try {
    res = await fetch(`${cfg.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: { apikey: cfg.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(502, "oauth_upstream", "Couldn't reach the sign-in service. Try again.");
  }
  // 4xx: a used, expired or forged code, or the wrong verifier.
  if (res.status >= 400 && res.status < 500) throw failed();
  if (!res.ok) throw new ApiError(502, "oauth_upstream", "The sign-in service had a problem. Try again.");
  const user = ((await res.json().catch(() => ({}))) as SupabaseSession).user;
  if (!user) throw failed();
  if (!user.email || !user.email_confirmed_at) {
    throw new ApiError(401, "oauth_no_email", "That account has no confirmed email address. Use one that does, or sign up with email.");
  }
  return { email: user.email, provider: user.app_metadata?.provider ?? "unknown" };
}
