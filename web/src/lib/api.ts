export type User = { id: number; email: string; name: string; email_verified: boolean; has_password: boolean; google: boolean };
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

export type Market = {
  symbol: string; name: string; asset_class: string; class_label: string; decimals: number; unit: string; lot: number;
  default_units: number; spread: number; max_leverage: number; hours: string; open_now: boolean; live: boolean;
  swap_long: number | null; swap_short: number | null; swap_long_pct: number; swap_short_pct: number;
  price: number | null; as_of: number | null; has_seconds: boolean; has_history: boolean;
};
export type MarketList = { default: string; classes: Record<string, string>; markets: Market[] };

const sym = (symbol?: string) => (symbol && symbol !== "XAUUSD" ? `symbol=${encodeURIComponent(symbol)}` : "");
const withSym = (path: string, symbol?: string) => {
  const q = sym(symbol);
  return q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
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
  kind: "trend" | "reversion" | "benchmark" | "custom";
  kind_label: string;
  params: StrategyParam[];
};

export type Operand = { ind: string; n?: number | null; m?: number | null; value?: number | null };
export type Condition = { left: Operand; op: "<" | ">" | "crosses_above" | "crosses_below"; right: Operand };
export type Rules = { name: string; long_entry: Condition[]; long_exit: Condition[]; short_entry: Condition[]; short_exit: Condition[] };
export type IndicatorSpec = { key: string; label: string; group: string; n: { label: string; default: number } | null; m: { label: string; default: number } | null };
export type CustomCatalog = {
  indicators: IndicatorSpec[];
  ops: { key: Condition["op"]; label: string }[];
  templates: { key: string; name: string; summary: string; rules: Rules }[];
  max_conditions: number;
};
export type SavedStrategy = { id: number; name: string; rules: Rules; description: string; created_at: string; updated_at: string };

export type PreviewTrade = { side: "long" | "short"; entry_time: number; entry_price: number; exit_time: number | null; exit_price: number | null; pnl: number | null; exit_reason: string | null };
export type SweepRow = { value: number; ok: boolean; return_pct?: number | null; max_drawdown_pct?: number; trades?: number; win_rate_pct?: number | null };
export type CustomPreview = {
  stats: Report["stats"]; equity: Report["equity"]; trades: PreviewTrade[];
  candles: { t: number; o: number; h: number; l: number; c: number }[]; in_market_pct: number; description: string;
};

/** A saved custom strategy shown in the same list as the built-in ones. */
export const asStrategy = (m: SavedStrategy): Strategy => ({
  key: `custom:${m.id}`, label: m.name, summary: m.description, kind: "custom", kind_label: "Your strategy", params: [],
});

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
  /** With realistic fills: stops that slipped because a big release fell inside their bar. */
  slipped_stops?: number;
};

export type Report = {
  stats: Stats;
  equity: { t: number; equity: number; drawdown: number }[];
  trades: ReportTrade[];
};

export type BacktestParams = {
  strategy: string;
  symbol?: string;
  params: Record<string, number>;
  rules?: Rules | null;
  tf: Timeframe;
  start: string;
  end?: string | null;
  direction: "both" | "long_only" | "short_only";
  capital: number;
  units?: number | null;
  spread?: number | null;
  swap_long?: number | null;
  swap_short?: number | null;
  stop_loss_pct?: number | null;
  take_profit_pct?: number | null;
  size_pct?: number | null;
  /** Wider spreads at the rollover and around big releases, and stops that slip around releases. */
  realistic_fills?: boolean;
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

export type PaperPrice = {
  symbol?: string; bid: number; ask: number; t: number; age_seconds: number; open: boolean; in_hours?: boolean; source: "live" | "bars";
  /** The spread right now, and why it is wider than usual, if it is. */
  spread?: number; wide?: "news" | "rollover" | null;
};
export type PaperPosition = {
  id: number;
  symbol?: string;
  name?: string;
  decimals?: number;
  side: "long" | "short";
  units: number;
  entry_price: number;
  opened_at: string;
  stop_loss: number | null;
  take_profit: number | null;
  order_kind: "market" | "limit" | "stop" | "agent";
  closed_at: string | null;
  exit_price: number | null;
  close_reason: "manual" | "partial" | "stop_loss" | "take_profit" | "stop_out" | "agent" | "challenge_daily_loss" | "challenge_max_loss" | null;
  swap: number | null;
  pnl: number | null;
  /** Trailing stop distance in price, when the stop follows the price. */
  trail?: number | null;
  mark?: number | null;
  margin?: number | null;
};
export type PaperOrder = {
  id: number;
  symbol?: string;
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
  trail?: number | null;
  /** The pending order this one is paired with as one-cancels-other. */
  oco_id?: number | null;
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
  margin_call?: boolean;
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
  /** The prop challenge the account is running, or null in free practice. */
  challenge?: PropChallenge | null;
  /** Why new trades are refused (a challenge that has ended), or null. */
  locked?: string | null;
  symbol?: string;
  market?: Omit<Market, "price" | "as_of" | "has_seconds" | "has_history">;
  settings: {
    spread: number; swap_long: number | null; swap_short: number | null; margin_rate_pct: number; stop_out_pct: number; margin_call_pct?: number;
    leverage: number; leverages: number[]; max_leverage: number; max_balance: number;
    market_leverage?: number; market_max_leverage?: number;
    realistic_fills?: boolean; spread_now?: number; wide?: "news" | "rollover" | null; news_spread_x?: number; rollover_spread_x?: number;
  };
};
export type PropHelp = { tip: string; lesson: { id: string; title: string; takeaway: string } | null };
export type PropCheck = {
  key: "target" | "daily_loss" | "max_loss" | "min_days";
  label: string;
  status: "ok" | "warn" | "open" | "done";
  value: number;
  limit: number;
  progress: number;
  floor?: number;
  text: string;
};
export type PropRules = { targets: number[]; daily_loss_pct: number; max_loss_pct: number; min_days: number; leverage: number; label?: string };
export type PropPhaseResult = {
  phase: number; balance: number; profit: number; profit_pct: number; trades: number; wins: number; trading_days: number;
  best_day: number | null; worst_day: number | null; worst_daily_pct: number; max_drawdown_pct: number; started_at: string | null;
};
export type PropChallenge = {
  id: number;
  plan: string;
  label: string;
  size: number;
  leverage: number;
  status: "active" | "passed" | "failed" | "abandoned";
  phase: number;
  phases: number;
  rules: PropRules;
  started_at: string;
  ended_at: string | null;
  phase_started_at: string;
  phase_results: PropPhaseResult[];
  final: PropPhaseResult | null;
  fail_rule: "daily_loss" | "max_loss" | null;
  fail_detail: string | null;
  fail_help: PropHelp | null;
  // Live numbers, only while the challenge is running.
  balance?: number;
  equity?: number;
  profit?: number;
  profit_pct?: number;
  target_pct?: number;
  target_balance?: number;
  trading_days?: number;
  open_positions?: number;
  day_start_balance?: number;
  checks?: PropCheck[];
  warnings?: ({ key: string; text: string } & PropHelp)[];
  at_stops?: number | null;
};
export type PropPlan = {
  id: "starter" | "two_step" | "one_step";
  label: string; blurb: string; sizes: number[]; targets: number[];
  daily_loss_pct: number; max_loss_pct: number; min_days: number; leverage: number;
};
export type PropOverview = { plans: PropPlan[]; current: PropChallenge | null; history: PropChallenge[]; max_leverage: number };
export type PropStartInput = {
  plan: PropPlan["id"] | "custom";
  size: number;
  custom?: Omit<PropRules, "label">;
};

export type PaperOrderInput = {
  symbol?: string;
  side: "long" | "short";
  kind: "market" | "limit" | "stop";
  units: number;
  price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  trail?: number | null;
  oco_with?: number | null;
};

export type CoachTag = "no_stop" | "stop_widened" | "revenge" | "oversized" | "red_folder" | "stop_out";
export type CoachTags = {
  labels: Record<CoachTag, { label: string; explain: string }>;
  by_trade: Record<string, CoachTag[]>;
  counts: Record<CoachTag, number>;
  trades: number;
  clean: number;
};
export type Playbook = { rules: string[]; custom: boolean; max: number };
export type PreTrade = { rules: string[]; warnings: { key: string; text: string }[]; risk_limit_pct: number };
type WeekSummary = { trades: number; net: number; win_rate_pct: number | null; clean_trades: number; tags: Partial<Record<CoachTag, number>> };
export type CoachWeek = {
  week: string; finished: boolean; source: "ai" | "rules"; created_at: string;
  headline: string; went_well: string[]; work_on: string; next_week_goal: string;
  facts: { this_week: WeekSummary; week_before: WeekSummary };
  trades: { id: number; symbol: string; side: "long" | "short"; pnl: number; tags: CoachTag[]; closed_at: string }[];
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
  custom_id?: number;
  rules?: Rules;
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
  rules?: Rules | null;
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

export type Badge = { key: string; title: string; blurb: string; icon: string; progress: number; goal: number; earned: boolean };
export type Achievements = { badges: Badge[]; earned: number; streak: { current: number; best: number; logged_today: boolean } };

export type LabStageKey = "spark" | "build" | "test" | "play" | "review";
export type LabAction = { title: string; detail: string; href: string; cta: string };
export type LabStage = LabAction & { key: LabStageKey; name: string; blurb: string; state: "done" | "current" | "todo"; done_at: string | null };
export type Lab = {
  xp: number;
  level: { rank: number; name: string; blurb: string; floor: number; next: { name: string; at: number } | null };
  sources: { key: string; label: string; count: number; each: number; xp: number }[];
  laps: number;
  stage: number;
  stages: LabStage[];
  mission: LabAction & { stage: LabStageKey | "limits"; xp: number };
  resume: { title: string; detail: string; href: string; ts: string }[];
  active_days_this_week: number;
};

export type PriceAlert = {
  id: number; price: number; direction: "above" | "below"; note: string;
  created_at: string; triggered_at: string | null; triggered_price: number | null;
};
export type Insight = { key: string; tone: "warn" | "info" | "good"; title: string; metric: string; body: string };
export type Insights = { source: "paper" | "journal"; trades: number; needed: number; win_rate_pct?: number; net?: number; items: Insight[] };
export type ReplayBar = { t: number; o: number; h: number; l: number; c: number };
export type ReplayTf = "5m" | "15m" | "1h";
export type ReplayTradeIn = { side: "long" | "short"; units: number; entry_bar: number; exit_bar: number; stop: number | null; target: number | null };
export type ReplaySettled = ReplayTradeIn & { entry_price: number; exit_price: number; reason: "closed" | "stop" | "target"; pnl: number };
export type ReplayScore = { balance: number; return_pct: number; max_drawdown_pct: number; trades: number; wins: number; detail: ReplaySettled[] };
export type Replay = {
  tf: ReplayTf; day: string; start: number; end: number; context: ReplayBar[]; bars: ReplayBar[];
  balance: number; leverage: number; range: { first: string; last: string };
};
export type SessionTf = ReplayTf;
export type SessionSummary = {
  id: number; name: string; tf: SessionTf; blind: boolean; finished: boolean; start: string | null; end: string | null;
  progress: { shown: number; trades: number }; result: ReplayScore | null; created_at: string; updated_at: string;
};
export type Session = SessionSummary & {
  state: Record<string, unknown>; bars: ReplayBar[]; context: ReplayBar[];
  htf: { tf: string; seconds: number; context: ReplayBar[] }; balance: number; leverage: number;
};

export type BoardRow = { rank: number; nickname: string | null; return_pct: number; max_drawdown_pct: number; trades: number; me: boolean };
export type Board = { players: number; top: BoardRow[]; mine: (BoardRow & { public: boolean }) | null };
export type Challenge = {
  week: string; ends: string; tf: ReplayTf; start: number; end: number;
  rules: { balance: number; leverage: number; risk_pct: number };
  context: ReplayBar[]; bars: ReplayBar[]; board: Board; nickname: string | null;
  last_week: (Board & { week: string }) | null;
};

export type TradeReview = {
  grade: "A" | "B" | "C" | "D"; headline: string; went_well: string[]; work_on: string[]; next_time: string;
  checklist_grade: string; source: "ai" | "checklist"; created_at: string;
  facts: { risked_pct: number | null; planned_reward_to_risk: number | null; result_in_r: number | null; trend_before_entry: string | null };
};
export type LessonSummary = { id: string; year: number; title: string; day: string; minutes: number; summary: string; watch: string[]; takeaway: string };
export type Lesson = LessonSummary & { body: string[]; next: string | null };
export type LessonProgress = Record<string, { return_pct: number; trades: number; completed_at: string }>;
export type ChartMarker = { t: number; title: string; kind: "fed" | "inflation" | "jobs" | "growth" | "dollar" | "shock" | "other"; impact: string; why: string; history: boolean };

export type DailyChoice = "buy" | "sell" | "wait";
export type LevelBar = { o: number; h: number; l: number; c: number };
export type DailyResult = {
  choice: DailyChoice; right: boolean; pnl_1000: number; against_pct: number;
  end_price: number; move_pct: number; high_pct: number; low_pct: number; best: DailyChoice;
  price: number; at: number; future: LevelBar[]; symbol: string;
  crowd: { buy: number; sell: number; wait: number; total: number };
  you: { streak: number; played: number; right: number } | null;
};
export type DailyCandle = { day: string; number: number; tf: string; horizon: number; bars: LevelBar[]; played: DailyResult | null };

export const api = {
  daily: () => call<DailyCandle>("/daily"),
  playDaily: (choice: DailyChoice) => call<DailyResult>("/daily", { method: "POST", body: JSON.stringify({ choice }) }),
  prefs: () => call<Record<string, unknown>>("/prefs"),
  setPref: (key: "drawings" | "indicators" | "chart_events" | "trading" | "mirror", value: unknown) =>
    call<{ ok: boolean }>(`/prefs/${key}`, { method: "PUT", body: JSON.stringify({ value }) }),
  markers: (start: number, end: number, scheduled = true) =>
    call<ChartMarker[]>(`/calendar/markers?start=${start}&end=${end}&scheduled=${scheduled}`),
  alerts: () => call<PriceAlert[]>("/practice/alerts"),
  addAlert: (price: number, note = "") => call<PriceAlert>("/practice/alerts", { method: "POST", body: JSON.stringify({ price, note }) }),
  deleteAlert: (id: number) => call<void>(`/practice/alerts/${id}`, { method: "DELETE" }),
  checkAlerts: () => call<{ triggered: PriceAlert[]; price: number | null }>("/practice/alerts/check", { method: "POST" }),
  insights: (source: "paper" | "journal") => call<Insights>(`/practice/insights?source=${source}`),
  replay: (o: { day?: string; tf: ReplayTf }) =>
    call<Replay>(`/practice/replay?tf=${o.tf}${o.day ? `&day=${o.day}` : ""}`),
  replaySettle: (b: { tf: ReplayTf; start: number; end: number; trades: ReplayTradeIn[] }) =>
    call<ReplayScore>("/practice/replay/settle", { method: "POST", body: JSON.stringify(b) }),
  sessions: () => call<SessionSummary[]>("/practice/sessions"),
  session: (id: number) => call<Session>(`/practice/sessions/${id}`),
  newSession: (b: { tf: SessionTf; start?: string | null; end?: string | null; blind: boolean; name?: string }) =>
    call<Session>("/practice/sessions", { method: "POST", body: JSON.stringify(b) }),
  saveSession: (id: number, state: unknown) =>
    call<{ ok: boolean }>(`/practice/sessions/${id}`, { method: "PUT", body: JSON.stringify({ state }) }),
  finishSession: (id: number, trades: ReplayTradeIn[]) =>
    call<SessionSummary>(`/practice/sessions/${id}/finish`, { method: "POST", body: JSON.stringify({ trades }) }),
  deleteSession: (id: number) => call<void>(`/practice/sessions/${id}`, { method: "DELETE" }),
  challenge: () => call<Challenge>("/practice/challenge"),
  enterChallenge: (b: { trades: ReplayTradeIn[]; public: boolean; nickname: string | null }) =>
    call<ReplayScore & { board: Board }>("/practice/challenge", { method: "POST", body: JSON.stringify(b) }),
  challengeVisibility: (pub: boolean, nickname: string | null) =>
    call<Board>("/practice/challenge", { method: "PATCH", body: JSON.stringify({ public: pub, nickname }) }),
  review: (id: number) => call<TradeReview>(`/practice/reviews/${id}`, { method: "POST" }),
  reviewGrades: () => call<Record<string, TradeReview["grade"]>>("/practice/reviews"),
  lessons: () => call<LessonSummary[]>("/learn"),
  lesson: (id: string) => call<Lesson>(`/learn/${encodeURIComponent(id)}`),
  lessonProgress: () => call<LessonProgress>("/learn/progress"),
  completeLesson: (id: string, b: { return_pct: number; trades: number }) =>
    call<LessonProgress>(`/learn/${encodeURIComponent(id)}/complete`, { method: "POST", body: JSON.stringify(b) }),
  achievements: () => call<Achievements>("/achievements"),
  lab: () => call<Lab>("/lab"),
  customCatalog: () => call<CustomCatalog>("/custom-strategies/catalog"),
  customList: () => call<SavedStrategy[]>("/custom-strategies"),
  customSave: (rules: Rules, id?: number) =>
    call<SavedStrategy>(id ? `/custom-strategies/${id}` : "/custom-strategies", { method: id ? "PUT" : "POST", body: JSON.stringify({ rules }) }),
  customPreview: (b: { rules: Rules; tf: "1d" | "1h"; years: number; stop_loss_pct: number | null }) =>
    call<CustomPreview>("/custom-strategies/preview", { method: "POST", body: JSON.stringify(b) }),
  customSweep: (b: { rules: Rules; tf: "1d" | "1h"; years: number; stop_loss_pct: number | null; lane: string; index: number;
    side: "left" | "right"; field: "n" | "m" | "value"; values: number[] }) =>
    call<SweepRow[]>("/custom-strategies/sweep", { method: "POST", body: JSON.stringify(b) }),
  customDraft: (text: string) =>
    call<{ rules: Rules; explanation: string; possible: boolean; description: string }>("/custom-strategies/draft", { method: "POST", body: JSON.stringify({ text }) }),
  customDelete: (id: number) => call<{ ok: boolean }>(`/custom-strategies/${id}`, { method: "DELETE" }),
  me: () => call<User>("/auth/me"),
  signup: (email: string, password: string, name: string) =>
    call<User>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    call<User>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => call<void>("/auth/logout", { method: "POST" }),
  authConfig: () => call<{ google: boolean }>("/auth/config"),
  forgotPassword: (email: string) =>
    call<{ sent: boolean }>("/auth/password/forgot", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, password: string) =>
    call<User>("/auth/password/reset", { method: "POST", body: JSON.stringify({ token, password }) }),
  verifyEmail: (token: string) =>
    call<{ verified: boolean; email: string }>("/auth/verify", { method: "POST", body: JSON.stringify({ token }) }),
  resendVerification: () => call<{ sent: boolean; already_verified?: boolean }>("/auth/verify/resend", { method: "POST" }),
  markets: () => call<MarketList>("/prices/markets"),
  summary: (symbol?: string) => call<Summary>(withSym("/prices/summary", symbol)),
  live: (symbol?: string) => call<LiveQuote>(withSym("/prices/live", symbol)),
  scenario: (p: Partial<ScenarioInput>) => call<Scenario>("/scenarios", { method: "POST", body: JSON.stringify(p) }),
  candles: (tf: ChartTf, opts: { start?: number; end?: number; limit?: number; symbol?: string } = {}) => {
    const q = new URLSearchParams({ tf, limit: String(opts.limit ?? 1000) });
    if (opts.symbol) q.set("symbol", opts.symbol);
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
  paper: (symbol?: string) => call<PaperState>(withSym("/paper", symbol)),
  paperOrder: (o: PaperOrderInput) =>
    call<{ position?: PaperPosition; order?: PaperOrder }>("/paper/orders", { method: "POST", body: JSON.stringify(o) }),
  paperCancel: (id: number) => call<void>(`/paper/orders/${id}`, { method: "DELETE" }),
  paperModify: (id: number, body: { price?: number; stop_loss?: number | null; take_profit?: number | null }) =>
    call<{ order: PaperOrder }>(`/paper/orders/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  /** Closes a position, or only `units` of it. */
  paperClose: (id: number, units?: number) =>
    call<{ position: PaperPosition }>(`/paper/positions/${id}/close`, { method: "POST", ...(units ? { body: JSON.stringify({ units }) } : {}) }),
  paperBreakeven: (id: number) => call<{ position: PaperPosition }>(`/paper/positions/${id}/breakeven`, { method: "POST" }),
  /** Moves the stop and target. `trail` left out keeps the trailing stop as it is; null turns it off. */
  paperProtect: (id: number, stop_loss: number | null, take_profit: number | null, trail?: number | null) =>
    call<{ position: PaperPosition }>(`/paper/positions/${id}`, {
      method: "PATCH", body: JSON.stringify(trail === undefined ? { stop_loss, take_profit } : { stop_loss, take_profit, trail }),
    }),
  paperReset: (balance: number, leverage: number, symbol?: string) =>
    call<PaperState>(withSym("/paper/reset", symbol), { method: "POST", body: JSON.stringify({ balance, leverage }) }),
  paperRealisticFills: (on: boolean, symbol?: string) =>
    call<PaperState>(withSym("/paper/settings", symbol), { method: "PATCH", body: JSON.stringify({ realistic_fills: on }) }),
  paperLeverage: (leverage: number, symbol?: string) =>
    call<PaperState>(withSym("/paper/settings", symbol), { method: "PATCH", body: JSON.stringify({ leverage }) }),
  paperFunds: (amount: number, symbol?: string) =>
    call<PaperState>(withSym("/paper/funds", symbol), { method: "POST", body: JSON.stringify({ amount }) }),
  coachTags: () => call<CoachTags>("/coach/tags"),
  coachPlaybook: () => call<Playbook>("/coach/playbook"),
  coachSavePlaybook: (rules: string[]) => call<Playbook>("/coach/playbook", { method: "PUT", body: JSON.stringify({ rules }) }),
  coachPreTrade: () => call<PreTrade>("/coach/pretrade"),
  coachWeek: (week?: string) => call<CoachWeek>(week ? `/coach/weekly?week=${week}` : "/coach/weekly"),
  paperReport: () => call<Report>("/paper/report"),
  prop: () => call<PropOverview>("/prop"),
  propStart: (body: PropStartInput) => call<{ current: PropChallenge }>("/prop/start", { method: "POST", body: JSON.stringify(body) }),
  propLeave: () => call<{ history: PropChallenge[] }>("/prop/leave", { method: "POST" }),
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
