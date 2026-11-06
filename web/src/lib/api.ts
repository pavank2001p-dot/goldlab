export type User = { id: number; email: string; name: string };
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Timeframe = "1h" | "1d";
export type ChartTf = "1s" | "5s" | "15s" | "30s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w" | "1mo";
export type LiveQuote = { price: number | null; t: number | null; age_seconds: number | null; connected: boolean; configured: boolean };
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
export type Strategy = {
  key: string;
  label: string;
  summary: string;
  kind: "trend" | "reversion" | "benchmark";
  kind_label: string;
  params: StrategyParam[];
};

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
  size_pct?: number | null;
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

export type NewsItem = {
  id: number;
  headline: string;
  summary: string;
  url: string;
  publisher: string;
  published_at: string;
  relevance: number;
  impact: "bullish" | "bearish" | "neutral" | null;
  reason: string | null;
};
export type NewsFeed = { configured: boolean; tagging: boolean; items: NewsItem[] };
export type CalendarEvent = {
  id: number;
  ts: string;
  country: string;
  title: string;
  impact: string;
  forecast: string;
  previous: string;
  source: string;
  why: string;
};
export type RiskQuestion = { key: string; category: string; text: string; options: string[]; visual?: "range" };
export type RiskCategory = { label: string; summary: string };
export type RiskBreakdown = RiskCategory & { key: string; pct: number };
export type RiskLimits = { label: string; summary: string; max_risk_per_trade_pct: number; max_drawdown_pct: number; max_leverage: number };
export type RiskProfile = RiskLimits & {
  profile: "conservative" | "moderate" | "aggressive";
  score: number;
  max_score: number;
  answers: Record<string, number>;
  updated_at: string;
  breakdown: RiskBreakdown[];
  complete: boolean;
};

export type FitCheck = { key: string; label: string; value: number | null; limit: number; unit: "%" | "x"; level: "fits" | "close" | "over" };
export type Fit = {
  profile: RiskProfile["profile"];
  profile_label: string;
  verdict: FitCheck["level"];
  verdict_label: string;
  checks: FitCheck[];
  notes: string[];
  trades_checked: number;
  units: number | null;
  suggested_units: number | null;
};
export type Turn = { role: "user" | "assistant"; content: string };
export type AssistantStatus = { configured: boolean; limit: number; used_today: number; remaining: number };
export type AssistantAnswer = { id: number; question: string; status: "pending" | "done" | "error"; answer: string | null; tools_used: string[] };

export type ScenarioInput = {
  side: "long" | "short";
  entry: number | null;
  units: number;
  stop: number | null;
  target: number | null;
  horizon_days: number;
  lookback_years: number;
  with_trend: boolean;
  capital: number;
};
type Pcts = { p5: number; p25: number; p50: number; p75: number; p95: number };
export type Scenario = {
  entry: number;
  side: "long" | "short";
  trading_days: number;
  paths: number;
  bands: (Pcts & { t: number })[];
  checkpoints: (Pcts & { label: string; t: number; above_entry_pct: number })[];
  outcomes: { target: number; stop: number; open: number };
  median_days_held: number;
  pnl: Pcts & { mean: number; profit_pct: number; histogram: { from: number; to: number; count: number }[] };
  loss_at_stop: number | null;
  loss_at_stop_pct: number | null;
  position_value: number;
  leverage: number;
  history: { days: number; yearly_volatility_pct: number; trend_removed: boolean; avg_yearly_move_pct: number; from: number | null };
  recent: { t: number; c: number }[];
  profile?: { profile: string; label: string; max_risk_per_trade_pct: number; max_leverage: number };
};

export type PaperPrice = { bid: number; ask: number; t: number; age_seconds: number; open: boolean; source: "live" | "bars" };
export type PaperPosition = {
  id: number;
  side: "long" | "short";
  units: number;
  entry_price: number;
  opened_at: string;
  stop_loss: number | null;
  take_profit: number | null;
  order_kind: "market" | "limit" | "stop" | "agent";
  closed_at: string | null;
  exit_price: number | null;
  close_reason: "manual" | "stop_loss" | "take_profit" | "stop_out" | "agent" | null;
  swap: number | null;
  pnl: number | null;
  mark?: number | null;
  margin?: number | null;
};
export type PaperOrder = {
  id: number;
  side: "long" | "short";
  kind: "limit" | "stop";
  units: number;
  price: number;
  stop_loss: number | null;
  take_profit: number | null;
  status: "pending" | "filled" | "cancelled";
  note: string;
  created_at: string;
  done_at: string | null;
};
export type PaperAccount = {
  starting_balance: number;
  leverage: number;
  balance: number;
  equity: number;
  unrealized: number;
  margin_used: number;
  free_margin: number;
  margin_level_pct: number | null;
  return_pct: number;
  created_at: string;
  closed_trades: number;
  wins: number;
  realized: number;
};
export type PaperState = {
  account: PaperAccount;
  price: PaperPrice | null;
  positions: PaperPosition[];
  orders: PaperOrder[];
  cancelled_orders: PaperOrder[];
  history: PaperPosition[];
  settings: {
    spread: number; swap_long: number; swap_short: number; margin_rate_pct: number; stop_out_pct: number;
    leverage: number; leverages: number[]; max_leverage: number; max_balance: number;
  };
};
export type PaperOrderInput = {
  side: "long" | "short";
  kind: "market" | "limit" | "stop";
  units: number;
  price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
};

export type PlanStats = {
  total_return_pct: number | null;
  cagr_pct: number | null;
  max_drawdown_pct: number | null;
  sharpe: number | null;
  trades: number;
  win_rate_pct: number | null;
  profit_factor: number | null;
  time_in_market_pct: number | null;
  wiped_out: boolean;
};
export type PlanInput = {
  profile?: RiskProfile["profile"] | null;
  tf: "1d" | "1h";
  years: number;
  style: "any" | "trend" | "reversion";
  direction: "both" | "long_only";
  capital: number;
  max_leverage?: number | null;
};
export type PlanResult = {
  strategy: string;
  label: string;
  kind: Strategy["kind"];
  kind_label: string;
  summary: string;
  params: Record<string, number>;
  param_labels: Record<string, string>;
  stop_loss_pct: number;
  size_pct: number;
  in_sample: PlanStats;
  in_sample_fit: FitCheck["level"];
  out_of_sample: PlanStats;
  out_of_sample_fit: FitCheck["level"];
  qualifies: boolean;
  score: number | null;
};
export type Plan = {
  profile: RiskProfile["profile"];
  profile_label: string;
  limits: { max_risk_per_trade_pct: number; max_drawdown_pct: number; max_leverage: number };
  max_leverage: number;
  capital: number;
  tf: "1d" | "1h";
  years: number;
  periods: { in_sample: { start: number; end: number }; out_of_sample: { start: number; end: number } };
  results: PlanResult[];
  benchmark: { in_sample: PlanStats; in_sample_fit: FitCheck["level"]; out_of_sample: PlanStats; out_of_sample_fit: FitCheck["level"]; size_pct: number };
  tried: number;
  last_price: number;
};
export type PlanOptions = {
  profiles: Record<string, RiskLimits>;
  years: Record<"1d" | "1h", number[]>;
  defaults: { profile: RiskProfile["profile"] | null; tf: "1d" | "1h"; max_leverage: number | null; complete: boolean };
  history_since: string;
};

export type AgentConfig = {
  strategy: string;
  params: Record<string, number>;
  tf: "1h" | "1d";
  direction: "both" | "long_only" | "short_only";
  stop_loss_pct: number;
  size_pct: number;
};
export type Finding = { key: string; severity: "high" | "medium" | "info"; title: string; detail: string };
export type Diagnosis = {
  findings: Finding[];
  by_market: Record<"up" | "down" | "range", { trades: number; pnl: number | null; win_rate_pct: number | null }>;
  worst_period: {
    from: string; to: string; depth_pct: number; gold_move_pct: number | null; market: string | null; market_label: string | null;
    trades: number; losing_trades: number; stop_outs: number; events: Record<string, number>;
    event_list: { date: string; title: string }[];
    headlines: { date: string; headline: string; impact: string; reason: string | null }[];
  } | null;
  median_atr_pct: number | null;
  gold_move_pct: number | null;
  fit: { verdict: FitCheck["level"]; verdict_label: string; checks: FitCheck[] } | null;
};
export type BriefStats = {
  total_return_pct: number | null; cagr_pct: number | null; max_drawdown_pct: number | null; trades: number;
  win_rate_pct: number | null; profit_factor: number | null; wiped_out: boolean;
};
export type AgentFix = { title: string; why: string; config: AgentConfig; stats: BriefStats; better: boolean; late: BriefStats | null; late_better: boolean | null };
export type PastTest = {
  config: AgentConfig; years: number; profile: string | null; period: { start: number; end: number };
  stats: Stats; equity: Report["equity"]; trades: ReportTrade[]; diagnosis: Diagnosis; fixes: AgentFix[];
};
export type AgentLog = { ts: string; kind: string; message: string };
export type AgentState = {
  agent: {
    status: "running" | "stopped"; started_at: string; stopped_at: string | null; last_bar: string | null;
    signal: number; blocked: number; config: AgentConfig; label: string; next_check: string | null;
  } | null;
  log: AgentLog[];
  live: {
    stats: Stats; equity: Report["equity"]; trades: ReportTrade[]; open: PaperPosition[];
    diagnosis: Diagnosis | null; backtest_same_days: { trades: number; pnl: number } | null;
  } | null;
  last_past_test: { result: Omit<PastTest, "equity" | "trades">; created_at: string } | null;
  price: { bid: number; ask: number; open: boolean } | null;
};

export const api = {
  me: () => call<User>("/auth/me"),
  signup: (email: string, password: string, name: string) =>
    call<User>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    call<User>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => call<void>("/auth/logout", { method: "POST" }),
  summary: () => call<Summary>("/prices/summary"),
  live: () => call<LiveQuote>("/prices/live"),
  scenario: (p: Partial<ScenarioInput>) => call<Scenario>("/scenarios", { method: "POST", body: JSON.stringify(p) }),
  candles: (tf: ChartTf, opts: { start?: number; end?: number; limit?: number } = {}) => {
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
  news: (goldOnly = false) => call<NewsFeed>(`/news?limit=100${goldOnly ? "&gold_only=true" : ""}`),
  calendar: (days = 14) => call<CalendarEvent[]>(`/calendar?days=${days}`),
  riskQuiz: () => call<{ questions: RiskQuestion[]; categories: Record<string, RiskCategory>; profiles: Record<string, RiskLimits> }>("/risk/quiz"),
  riskProfile: () => call<RiskProfile>("/risk/profile"),
  saveRiskProfile: (answers: Record<string, number>) =>
    call<RiskProfile>("/risk/profile", { method: "POST", body: JSON.stringify({ answers }) }),
  planOptions: () => call<PlanOptions>("/plans/options"),
  plan: (p: PlanInput) => call<Plan>("/plans/match", { method: "POST", body: JSON.stringify(p) }),
  backtestFit: (id: number) => call<Fit>(`/fit/backtests/${id}`),
  tradeFit: (capital: number) => call<Fit>(`/fit/trades?capital=${capital}`),
  paper: () => call<PaperState>("/paper"),
  paperOrder: (o: PaperOrderInput) =>
    call<{ position?: PaperPosition; order?: PaperOrder }>("/paper/orders", { method: "POST", body: JSON.stringify(o) }),
  paperCancel: (id: number) => call<void>(`/paper/orders/${id}`, { method: "DELETE" }),
  paperClose: (id: number) => call<{ position: PaperPosition }>(`/paper/positions/${id}/close`, { method: "POST" }),
  paperProtect: (id: number, stop_loss: number | null, take_profit: number | null) =>
    call<{ position: PaperPosition }>(`/paper/positions/${id}`, { method: "PATCH", body: JSON.stringify({ stop_loss, take_profit }) }),
  paperReset: (balance: number, leverage: number) =>
    call<PaperState>("/paper/reset", { method: "POST", body: JSON.stringify({ balance, leverage }) }),
  paperLeverage: (leverage: number) => call<PaperState>("/paper/settings", { method: "PATCH", body: JSON.stringify({ leverage }) }),
  paperFunds: (amount: number) => call<PaperState>("/paper/funds", { method: "POST", body: JSON.stringify({ amount }) }),
  paperReport: () => call<Report>("/paper/report"),
  paperFit: () => call<Fit>("/paper/fit"),
  agent: () => call<AgentState>("/agent"),
  agentPast: (c: AgentConfig & { years: number }) => call<PastTest>("/agent/past", { method: "POST", body: JSON.stringify(c) }),
  agentStart: (c: AgentConfig) => call<AgentState>("/agent/start", { method: "POST", body: JSON.stringify(c) }),
  agentStop: (close_position: boolean) => call<AgentState>("/agent/stop", { method: "POST", body: JSON.stringify({ close_position }) }),
  agentCoach: (situation: string) => call<{ id: number }>("/agent/coach", { method: "POST", body: JSON.stringify({ situation }) }),
  assistantStatus: () => call<AssistantStatus>("/assistant/status"),
  ask: (question: string, history: Turn[]) =>
    call<{ id: number }>("/assistant/questions", { method: "POST", body: JSON.stringify({ question, history }) }),
  answer: (id: number) => call<AssistantAnswer>(`/assistant/questions/${id}`),
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
