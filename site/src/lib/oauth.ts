import { api, setToken, type SignedIn } from "./api";
import { safeNext } from "./router";

/**
 * Google, GitHub, ... sign-in through Supabase Auth, with PKCE and no SDK:
 * send the person to Supabase with a code challenge, and when they come back
 * to /auth/callback with a one-time code, the Rampart API trades code +
 * verifier for a session. Set VITE_SUPABASE_URL at build time to turn it on.
 */

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/+$/, "");
const STATE_KEY = "rampart.oauth";

export const OAUTH_PROVIDERS = SUPABASE_URL
  ? ([
      { id: "google", label: "Continue with Google" },
      { id: "github", label: "Continue with GitHub" },
    ] as const)
  : [];
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number]["id"];

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startOAuth(provider: OAuthProvider, next: string) {
  if (!SUPABASE_URL) throw new Error("Sign-in with Google or GitHub isn't set up.");
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ verifier, next }));
  } catch {
    throw new Error("Your browser blocked storage this sign-in needs. Allow site data, or sign in with email.");
  }
  const params = new URLSearchParams({
    provider,
    redirect_to: `${window.location.origin}/auth/callback`,
    code_challenge: challenge,
    code_challenge_method: "s256",
  });
  window.location.assign(`${SUPABASE_URL}/auth/v1/authorize?${params}`);
}

/** Finishes the sign-in on /auth/callback; returns where to go next. */
export async function finishOAuth(): Promise<string> {
  // Supabase reports a cancelled or failed sign-in in the query or the fragment.
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const code = query.get("code");
  let saved: { verifier?: string; next?: string } = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "{}");
    sessionStorage.removeItem(STATE_KEY);
  } catch {
    /* treated as a missing sign-in below */
  }
  const failure = query.get("error_description") ?? hash.get("error_description");
  if (failure) throw new Error(failure.replace(/\+/g, " "));
  if (!code || !saved.verifier) throw new Error("That sign-in link has expired. Start again.");
  const session = await api<SignedIn>("/v1/auth/oauth", { body: { code, code_verifier: saved.verifier } });
  setToken(session.token);
  return safeNext(saved.next ?? null);
}
