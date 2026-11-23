import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { api, setToken, type SignedIn } from "./api";
import { safeNext } from "./router";

/**
 * Email + password, Google and GitHub sign-in run on Supabase Auth, so every
 * account is a Supabase user. Once Supabase signs someone in, the Rampart API
 * checks the access token and returns its own rds_ session, and the Supabase
 * session in the browser is dropped. Set VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY at build time.
 */

const URL_ = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/+$/, "");
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const SUPABASE_READY = Boolean(URL_ && ANON_KEY);

export const OAUTH_PROVIDERS = [
  { id: "google", label: "Continue with Google" },
  { id: "github", label: "Continue with GitHub" },
] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number]["id"];

const NEXT_KEY = "rampart.next";
const callbackUrl = () => `${window.location.origin}/auth/callback`;

let client: Promise<SupabaseClient> | undefined;
// Loaded on first use, so the landing page doesn't ship the auth code.
function supabase(): Promise<SupabaseClient> {
  if (!URL_ || !ANON_KEY) return Promise.reject(new Error("Email sign-in isn't set up on this site yet. Use a wallet for now."));
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(URL_, ANON_KEY, { auth: { flowType: "pkce", detectSessionInUrl: false, autoRefreshToken: false } }),
  );
  return client;
}

function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return "Email or password is incorrect.";
  if (/email not confirmed/i.test(message)) return "Confirm your email address first, using the link we sent you.";
  if (/rate limit/i.test(message)) return "Too many attempts. Wait a minute and try again.";
  return message;
}

/** Trades the Supabase session for a Rampart one. */
async function finish(sb: SupabaseClient, session: Session): Promise<SignedIn> {
  try {
    const signedIn = await api<SignedIn>("/v1/auth/supabase", { body: { access_token: session.access_token } });
    setToken(signedIn.token);
    return signedIn;
  } finally {
    await sb.auth.signOut({ scope: "local" }).catch(() => {});
  }
}

/** "signed-in", or "confirm" when Supabase emailed a confirmation link first. */
export async function emailSignUp(email: string, password: string): Promise<"signed-in" | "confirm"> {
  const sb = await supabase();
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: callbackUrl() } });
  if (error) throw new Error(friendly(error.message));
  if (!data.session) return "confirm";
  await finish(sb, data.session);
  return "signed-in";
}

export async function emailSignIn(email: string, password: string): Promise<void> {
  const sb = await supabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendly(error.message));
  await finish(sb, data.session);
}

export async function oauthSignIn(provider: OAuthProvider, next: string): Promise<void> {
  const sb = await supabase();
  try {
    sessionStorage.setItem(NEXT_KEY, next);
  } catch {
    /* lands on the dashboard instead */
  }
  const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: callbackUrl() } });
  if (error) throw new Error(friendly(error.message));
}

/** On /auth/callback, after Google/GitHub or an email confirmation link: returns where to go next. */
export async function finishCallback(): Promise<string> {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const failure = query.get("error_description") ?? hash.get("error_description");
  if (failure) throw new Error(failure.replace(/\+/g, " "));
  const code = query.get("code");
  if (!code) throw new Error("That sign-in link is incomplete. Start again.");
  const sb = await supabase();
  const { data, error } = await sb.auth.exchangeCodeForSession(code);
  if (error) throw new Error(/code verifier|invalid flow state/i.test(error.message) ? "Open the link in the browser you signed up with, or sign in again." : friendly(error.message));
  await finish(sb, data.session);
  let next: string | null = null;
  try {
    next = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
  } catch {
    /* default below */
  }
  return safeNext(next);
}
