export type User = { id: number; email: string; name: string };
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Timeframe = "1h" | "1d";
export type Summary = {
  symbol: string;
  price: number | null;
  as_of?: number;
  change_24h?: number | null;
  change_24h_pct?: number | null;
  first_bar?: number;
  hourly_bars?: number;
  source: string;
  updated_at?: string | null;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = typeof body.detail === "string" ? body.detail : (body.detail?.[0]?.msg ?? msg);
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  me: () => call<User>("/auth/me"),
  signup: (email: string, password: string, name: string) =>
    call<User>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    call<User>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => call<void>("/auth/logout", { method: "POST" }),
  summary: () => call<Summary>("/prices/summary"),
  candles: (tf: Timeframe, opts: { start?: number; end?: number; limit?: number } = {}) => {
    const q = new URLSearchParams({ tf, limit: String(opts.limit ?? 1000) });
    if (opts.start !== undefined) q.set("start", String(opts.start));
    if (opts.end !== undefined) q.set("end", String(opts.end));
    return call<{ bars: Bar[] }>(`/prices/candles?${q}`).then((r) => r.bars);
  },
};

export const fmtPrice = (p: number) => p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
