import { horizonUrl } from "./network";

/** Minimal Horizon client. `fetchImpl` is injectable so tests don't hit the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type HorizonBalance = {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  is_authorized?: boolean;
  selling_liabilities?: string;
};

export type HorizonAccount = {
  id: string;
  sequence: string;
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: HorizonBalance[];
};

export type HorizonOperation = {
  type: string;
  transaction_successful?: boolean;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  // create_claimable_balance
  asset?: string;
  claimants?: { destination: string }[];
};

export class HorizonClient {
  constructor(
    private readonly baseUrl = horizonUrl(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async get<T>(path: string): Promise<T | null> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { Accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  account(address: string) {
    return this.get<HorizonAccount>(`/accounts/${address}`);
  }

  transaction(hash: string) {
    return this.get<{ hash: string; successful: boolean; ledger: number; memo?: string; memo_type?: string }>(
      `/transactions/${hash}`,
    );
  }

  async operations(hash: string): Promise<HorizonOperation[]> {
    const page = await this.get<{ _embedded: { records: HorizonOperation[] } }>(`/transactions/${hash}/operations?limit=200`);
    return page?._embedded.records ?? [];
  }

  async submit(xdr: string): Promise<{ hash: string; successful: boolean; extras?: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: xdr }).toString(),
    });
    const body = (await res.json()) as { hash?: string; successful?: boolean; extras?: unknown };
    if (!res.ok) return { hash: body.hash ?? "", successful: false, extras: body.extras ?? body };
    return { hash: body.hash!, successful: body.successful ?? true };
  }
}
