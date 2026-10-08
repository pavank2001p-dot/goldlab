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
  const isForm = init?.body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: isForm ? init?.headers : { "Content-Type": "application/json", ...init?.headers },
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

export type StrategyParam = { key: string; label: string; default: number; min: number; max: number; step: number };
export type Strategy = { key: string; label: string; summary: string; params: StrategyParam[] };

export type ReportTrade = {
  id?: number;
  side: "long" | "short";
  units: number;
  entry_time: number;
  entry_price: number;
  exit_time: number;
  exit_price: number;
  costs: number;
  swap: number;
  pnl: number;
  exit_reason?: string;
};

export type Stats = {
  starting_capital: number;
  final_equity: number;
  net_profit: number;
  total_return_pct: number | null;
  cagr_pct: number | null;
  max_drawdown_pct: number;
  max_drawdown_usd: number;
  sharpe: number | null;
  trades: number;
  win_rate_pct: number | null;
  profit_factor: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  largest_loss: number | null;
  expectancy: number | null;
  avg_hold_hours: number | null;
  longest_losing_streak: number;
  total_costs: number;
  total_swap: number;
  buy_and_hold_pct?: number;
  time_in_market_pct?: number;
  bars?: number;
  wiped_out?: boolean;
};

export type Report = {
  stats: Stats;
  equity: { t: number; equity: number; drawdown: number }[];
  trades: ReportTrade[];
};

export type BacktestParams = {
  strategy: string;
  params: Record<string, number>;
  tf: Timeframe;
  start: string;
  end?: string | null;
  direction: "both" | "long_only" | "short_only";
  capital: number;
  units: number;
  spread: number;
  swap_long: number;
  swap_short: number;
  stop_loss_pct?: number | null;
  take_profit_pct?: number | null;
};

export type Backtest = Report & { id: number; created_at: string; params: BacktestParams; period?: { start: number; end: number } };
export type BacktestSummary = { id: number; created_at: string; params: BacktestParams; stats: Stats };

export type Trade = {
  id: number;
  side: "long" | "short";
  units: number;
  open_time: string;
  open_price: number;
  close_time: string | null;
  close_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  fees: number;
  swap: number;
  notes: string;
  source: string;
  pnl: number | null;
};
export type TradeInput = Omit<Trade, "id" | "source" | "pnl">;
export type ImportResult = { imported: number; duplicates: number; skipped: string[]; skipped_count: number };

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
  strategies: () => call<Strategy[]>("/backtests/strategies"),
  runBacktest: (p: BacktestParams) => call<Backtest>("/backtests", { method: "POST", body: JSON.stringify(p) }),
  backtests: () => call<BacktestSummary[]>("/backtests"),
  backtest: (id: number) => call<Backtest>(`/backtests/${id}`),
  deleteBacktest: (id: number) => call<void>(`/backtests/${id}`, { method: "DELETE" }),
  trades: () => call<Trade[]>("/trades"),
  addTrade: (t: TradeInput) => call<Trade>("/trades", { method: "POST", body: JSON.stringify(t) }),
  deleteTrade: (id: number) => call<void>(`/trades/${id}`, { method: "DELETE" }),
  tradeReport: (capital: number) => call<Report>(`/trades/report?capital=${capital}`),
  importTrades: (file: File, contractSize: number) => {
    const f = new FormData();
    f.append("file", file);
    f.append("contract_size", String(contractSize));
    return call<ImportResult>("/trades/import", { method: "POST", body: f });
  },
};

export const fmtUsd = (v: number | null | undefined) =>
  v == null ? "–" : `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtPct = (v: number | null | undefined) => (v == null ? "–" : `${v.toFixed(2)}%`);
export const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleString("en-GB", { timeZone: "UTC", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export const fmtPrice = (p: number) => p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
