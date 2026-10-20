/** The Rampart API the dashboard talks to. Set VITE_RAMPART_API_URL at build time; defaults to a local server. */
export const API_URL = (import.meta.env.VITE_RAMPART_API_URL as string | undefined)?.replace(/\/+$/, "") || "http://localhost:8080";

const TOKEN_KEY = "rampart.session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// The token lives in localStorage: the API is on another origin, so a cookie would be third-party.
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session lasts until the tab closes */
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(`Can't reach the Rampart API at ${API_URL}. Is it running?`, "network_error", 0);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: { message: string }[] } };
  if (!res.ok) {
    const e = data.error;
    // Validation errors carry the useful text in details.
    const message = e?.code === "validation_error" && e.details?.[0] ? e.details[0].message : e?.message;
    throw new ApiError(message ?? `Request failed (${res.status}).`, e?.code ?? "http_error", res.status);
  }
  return data as T;
}

export type User = { id: string; email: string | null; wallet_address: string | null; created_at: string };
export type SignedIn = { token: string; expires_at: string; user: User };
export type ApiKey = { id: string; mode: "live" | "test"; prefix: string; created_at: string; revoked_at: string | null };
export type Project = { id: string; name: string; webhook_url: string | null; created_at: string; api_keys: ApiKey[] };
