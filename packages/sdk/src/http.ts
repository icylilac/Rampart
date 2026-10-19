import { RicercaError } from "./errors.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type RequestOptions = {
  baseUrl: string;
  token: string;
  fetch: FetchLike;
  timeoutMs: number;
  /** How many times to retry a safe request after a network error, 429 or 5xx. */
  maxRetries: number;
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One JSON request to the API. Only requests that are safe to repeat
 * (`retry: true`) are retried, with exponential backoff and jitter.
 */
export async function request<T>(
  opts: RequestOptions,
  method: "GET" | "POST",
  path: string,
  init: { body?: unknown; query?: Record<string, string | number | undefined>; retry?: boolean } = {},
): Promise<T> {
  const url = new URL(path, opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const attempts = init.retry ? opts.maxRetries + 1 : 1;
  let lastError: RicercaError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(4000, 300 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
    let res: Response;
    try {
      res = await opts.fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      lastError = new RicercaError(`Could not reach Ricerca Ramp: ${(e as Error).message}`, "network_error", 0);
      continue;
    }

    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (res.ok) return json as T;

    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    lastError = new RicercaError(err?.message ?? `HTTP ${res.status}`, err?.code ?? "http_error", res.status, err?.details);
    if (!RETRYABLE.has(res.status)) break;
  }
  throw lastError!;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
