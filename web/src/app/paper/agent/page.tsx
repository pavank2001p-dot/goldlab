"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import EquityChart from "@/components/EquityChart";
import Rich from "@/components/Rich";
import SignInPrompt from "@/components/SignInPrompt";
import { Empty, Icon, PageHeader } from "@/components/ui";
import {
  api, ApiError, fmtPct, type AgentConfig, type AgentFix, type AgentState, type BriefStats, type Diagnosis, type PastTest, type Strategy,
} from "@/lib/api";
import { useUser } from "@/lib/useUser";

const input = "w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-gold";
const POLL_MS = 30_000;
const SEV = { high: "border-down/50 bg-down/10", medium: "border-gold/40 bg-gold/10", info: "border-border bg-surface" };
const DOT = { high: "bg-down", medium: "bg-gold", info: "bg-muted" };
const MARKET = { up: "Uptrend", down: "Downtrend", range: "Sideways" } as const;

const ret = (v: number | null | undefined) =>
  v == null ? "–" : <span className={v >= 0 ? "text-up" : "text-down"}>{`${v > 0 ? "+" : ""}${v.toFixed(1)}%`}</span>;
const usd = (v: number | null | undefined) =>
  v == null ? "–" : <span className={v >= 0 ? "text-up" : "text-down"}>{`${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}</span>;
const when = (s: string) => new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Mark({ ok }: { ok: boolean | null }) {
  if (ok == null) return <span className="text-muted">–</span>;
  return ok ? <span className="text-up">Better</span> : <span className="text-down">Worse</span>;
}

function Findings({ d }: { d: Diagnosis }) {
  return (
    <ul className="space-y-2">
      {d.findings.map((f) => (
        <li key={f.key} className={`rounded-lg border p-3 ${SEV[f.severity]}`}>
          <p className="flex items-center gap-2 text-sm font-medium"><span className={`h-2 w-2 rounded-full ${DOT[f.severity]}`} />{f.title}</p>
          <p className="mt-1 text-sm text-muted">{f.detail}</p>
        </li>
      ))}
    </ul>
  );
}

function WorstPeriod({ d }: { d: Diagnosis }) {
  const w = d.worst_period;
  if (!w) return null;
  const events = Object.entries(w.events);
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 text-sm">
      <h3 className="font-medium">Worst stretch: {w.from} to {w.to}</h3>
      <p className="mt-1 text-muted">
        The account fell <b className="text-down">{Math.abs(w.depth_pct).toFixed(1)}%</b> from its peak while gold{" "}
        {w.gold_move_pct == null ? "moved" : w.gold_move_pct >= 0 ? `rose ${w.gold_move_pct.toFixed(1)}%` : `fell ${Math.abs(w.gold_move_pct).toFixed(1)}%`}
        {w.market_label && <> in mostly {w.market_label}</>}. {w.losing_trades} of the {w.trades} trades that closed in it lost money
        {w.stop_outs ? `, ${w.stop_outs} of them at the stop loss` : ""}.
      </p>
      {events.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {events.map(([k, n]) => <span key={k} className="rounded-lg border border-border px-2 py-0.5 text-xs">{n} {k}</span>)}
        </p>
      )}
      {w.headlines.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {w.headlines.slice(0, 5).map((h, i) => (
            <li key={i} className="text-xs">
              <span className="text-muted">{h.date} · </span>
              <span className={h.impact === "bullish" ? "text-up" : h.impact === "bearish" ? "text-down" : "text-muted"}>{h.impact}</span>
              <span> · {h.headline}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ByMarket({ d }: { d: Diagnosis }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-sm">
      {(["up", "down", "range"] as const).map((k) => {
        const m = d.by_market[k];
        return (
          <div key={k} className="rounded-lg bg-background p-3">
            <p className="text-xs text-muted">{MARKET[k]}</p>
            <p className="mt-1 tabular-nums">{usd(m.pnl)}</p>
            <p className="text-xs text-muted tabular-nums">{m.trades} trades{m.win_rate_pct != null && `, ${m.win_rate_pct.toFixed(0)}% won`}</p>
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg tabular-nums">{children}</p>
    </div>
  );
}

function FixRow({ f, base, use }: { f: AgentFix; base: BriefStats; use: (c: AgentConfig) => void }) {
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2">
        <p className="font-medium">{f.title}</p>
        <p className="text-xs text-muted">{f.why}</p>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{ret(f.stats.cagr_pct ?? f.stats.total_return_pct)}<br /><span className="text-xs text-muted">was {fmtPct(base.cagr_pct ?? base.total_return_pct)}</span></td>
      <td className="px-3 py-2 text-right tabular-nums text-down">{fmtPct(f.stats.max_drawdown_pct)}<br /><span className="text-xs text-muted">was {fmtPct(base.max_drawdown_pct)}</span></td>
      <td className="px-3 py-2 text-right"><Mark ok={f.better} /></td>
      <td className="px-3 py-2 text-right"><Mark ok={f.late_better} /></td>
      <td className="px-3 py-2 text-right">
        <button onClick={() => use(f.config)} className="rounded-lg border border-border px-2 py-1 text-xs hover:border-gold hover:text-gold">Use</button>
      </td>
    </tr>
  );
}

function Coach({ hasData }: { hasData: boolean }) {
  const [situation, setSituation] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const { id } = await api.agentCoach(situation);
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const a = await api.answer(id);
        if (a.status !== "pending") {
          if (a.status === "error") setError(a.answer ?? "The coach couldn't answer. Try again.");
          else setAnswer(a.answer);
          return;
        }
      }
      setError("The coach is taking too long. Try again in a minute.");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 503 ? "The AI coach isn't switched on for this site yet."
        : e instanceof Error ? e.message : "The coach couldn't answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gold/40 bg-gradient-to-br from-gold/10 to-transparent p-4">
      <h2 className="flex items-center gap-2 font-medium"><Icon name="assistant" className="h-4 w-4 text-gold" />AI coach</h2>
      <p className="mt-1 text-sm text-muted">
        Reads your latest past test and the agent&apos;s live results, then explains what went wrong and what the tested fixes changed.
        Describe a situation to ask about it too, like &quot;gold drops 5% after a Fed meeting&quot;.
      </p>
      <textarea value={situation} onChange={(e) => setSituation(e.target.value)} maxLength={1200} rows={2}
        placeholder="Optional: describe a situation or ask a question" className={`${input} mt-3 resize-y`} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{hasData ? "Uses one of your daily assistant questions." : "Run a past test first for the best answer."}</span>
        <button onClick={ask} disabled={busy} className="rounded-lg bg-gold px-3 py-1.5 text-sm font-medium text-black disabled:opacity-60">
          {busy ? "Thinking…" : "Ask the coach"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-down">{error}</p>}
      {answer && <div className="mt-3 border-t border-border pt-2 text-sm leading-relaxed"><Rich text={answer} /></div>}
    </div>
  );
}

function LiveCard({ s, act, busy }: { s: AgentState; act: (fn: () => Promise<AgentState>) => void; busy: boolean }) {
  const [closeIt, setCloseIt] = useState(true);
  const a = s.agent!;
  const live = s.live;
  const running = a.status === "running";
  const c = a.config;
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-medium">
            <span className={`h-2 w-2 rounded-full ${running ? "breathe bg-up" : "bg-muted"}`} />
            {a.label} {running ? "is running on paper" : "is stopped"}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {c.tf === "1h" ? "Hourly" : "Daily"} candles · {c.direction === "both" ? "long and short" : c.direction.replace("_", " ")} ·{" "}
            {c.size_pct.toFixed(0)}% of the account per trade · {c.stop_loss_pct}% stop · since {when(a.started_at)}
          </p>
        </div>
        {running && (
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-muted">
              <input type="checkbox" checked={closeIt} onChange={(e) => setCloseIt(e.target.checked)} className="accent-[var(--gold)]" />
              Close its position
            </label>
            <button disabled={busy} onClick={() => act(() => api.agentStop(closeIt))}
              className="rounded-lg border border-down/60 px-3 py-1.5 text-sm text-down hover:bg-down/10 disabled:opacity-60">Stop agent</button>
          </div>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Signal now">{a.signal === 1 ? "Long" : a.signal === -1 ? "Short" : "Flat"}</Stat>
        <Stat label="Closed trades">{live?.stats.trades ?? 0}</Stat>
        <Stat label="Net result">{usd(live?.stats.net_profit)}</Stat>
        <Stat label="Win rate">{fmtPct(live?.stats.win_rate_pct)}</Stat>
      </div>
      {live?.backtest_same_days && (
        <p className="mt-2 text-xs text-muted">
          A backtest of the same settings over these days made {live.backtest_same_days.trades} trades for{" "}
          {usd(live.backtest_same_days.pnl)}. Differences come from live fills, timing and spread.
        </p>
      )}
      {running && a.blocked !== 0 && (
        <p className="mt-2 text-xs text-gold">Its last {a.blocked === 1 ? "long" : "short"} was stopped out, so it waits for the signal to change before trading that way again.</p>
      )}
      {live?.diagnosis && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">What went wrong live</h3>
          <Findings d={live.diagnosis} />
        </div>
      )}
      <h3 className="mb-2 mt-4 text-sm font-medium">Activity</h3>
      <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1 text-sm">
        {s.log.map((e, i) => (
          <li key={i} className="flex gap-2">
            <span className="w-24 shrink-0 text-xs text-muted tabular-nums">{when(e.ts)}</span>
            <span className={e.kind === "open" ? "text-foreground" : e.kind === "close" || e.kind === "closed" ? "text-foreground" : "text-muted"}>{e.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AgentPage() {
  const { user } = useUser();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [form, setForm] = useState<(AgentConfig & { years: number }) | null>(null);
  const [past, setPast] = useState<PastTest | null>(null);
  const [state, setState] = useState<AgentState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const results = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => api.agent().then(setState, () => {}), []);

  useEffect(() => {
    if (!user) return;
    api.strategies().then((list) => {
      const usable = list.filter((s) => s.kind !== "benchmark");
      setStrategies(usable);
      const first = usable[0];
      let plan: Partial<AgentConfig> | null = null;
      try {
        plan = JSON.parse(new URLSearchParams(window.location.search).get("plan") ?? "null");
      } catch {}
      const base = { strategy: first.key, params: Object.fromEntries(first.params.map((p) => [p.key, p.default])), tf: "1d" as const,
        direction: "both" as const, stop_loss_pct: 3, size_pct: 33, years: 5 };
      setForm(plan?.strategy && usable.some((s) => s.key === plan.strategy)
        ? { ...base, ...plan, stop_loss_pct: plan.stop_loss_pct ?? 3, size_pct: plan.size_pct ?? 33 } as AgentConfig & { years: number }
        : base);
    });
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [user, refresh]);

  if (user === null) return <SignInPrompt what="run a strategy agent on your paper account" next="/paper/agent" />;
  if (!user || !form) return null;

  const strategy = strategies.find((s) => s.key === form.strategy)!;
  const set = (patch: Partial<AgentConfig & { years: number }>) => setForm({ ...form, ...patch });
  const running = state?.agent?.status === "running";

  async function run<T>(fn: () => Promise<T>, done: (v: T) => void) {
    setBusy(true);
    setError(null);
    try {
      done(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  const testPast = () => run(() => api.agentPast(form), (p) => {
    setPast(p);
    setTimeout(() => results.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  });
  const act = (fn: () => Promise<AgentState>) => run(fn, setState);
  const { years, ...config } = form;
  void years;

  function use(c: AgentConfig) {
    setForm({ ...form!, ...c });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const base: BriefStats | null = past && {
    total_return_pct: past.stats.total_return_pct, cagr_pct: past.stats.cagr_pct, max_drawdown_pct: past.stats.max_drawdown_pct,
    trades: past.stats.trades, win_rate_pct: past.stats.win_rate_pct, profit_factor: past.stats.profit_factor, wiped_out: false,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader icon="assistant" title="Strategy agent"
        subtitle="Tests a strategy on past gold prices, explains what went wrong and tries fixes, then trades it for you automatically on your paper account."
        right={<Link href="/paper" className="hidden rounded-lg border border-border px-3 py-1.5 text-sm hover:border-muted sm:block">Back to paper trading</Link>} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-4">
          <div className="space-y-3 rounded-2xl border border-border bg-surface p-4">
            <h2 className="font-medium">Setup</h2>
            <Field label="Strategy">
              <select className={input} value={form.strategy} onChange={(e) => {
                const s = strategies.find((x) => x.key === e.target.value)!;
                set({ strategy: s.key, params: Object.fromEntries(s.params.map((p) => [p.key, p.default])) });
              }}>
                {(["trend", "reversion"] as const).map((k) => (
                  <optgroup key={k} label={k === "trend" ? "Trend following" : "Mean reversion"}>
                    {strategies.filter((s) => s.kind === k).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <p className="text-xs text-muted">{strategy?.summary}</p>
            <div className="grid grid-cols-2 gap-3">
              {strategy?.params.map((p) =>
                p.min === 0 && p.max === 1 && p.step === 1 ? (
                  <label key={p.key} className="col-span-2 flex items-center gap-2 text-sm text-muted">
                    <input type="checkbox" checked={!!form.params[p.key]} className="accent-[var(--gold)]"
                      onChange={(e) => set({ params: { ...form.params, [p.key]: e.target.checked ? 1 : 0 } })} />
                    {p.label.replace(" (1 = yes)", "")}
                  </label>
                ) : (
                  <Field key={p.key} label={p.label}>
                    <input type="number" className={input} value={form.params[p.key] ?? p.default} step={p.step} min={p.min} max={p.max}
                      onChange={(e) => set({ params: { ...form.params, [p.key]: Number(e.target.value) } })} />
                  </Field>
                ),
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Candles">
                <select className={input} value={form.tf} onChange={(e) => {
                  const tf = e.target.value as AgentConfig["tf"];
                  set({ tf, years: tf === "1h" ? Math.min(form.years, 2) : form.years });
                }}>
                  <option value="1d">Daily</option>
                  <option value="1h">Hourly</option>
                </select>
              </Field>
              <Field label="Trades">
                <select className={input} value={form.direction} onChange={(e) => set({ direction: e.target.value as AgentConfig["direction"] })}>
                  <option value="both">Long and short</option>
                  <option value="long_only">Long only</option>
                  <option value="short_only">Short only</option>
                </select>
              </Field>
              <Field label="Stop loss (%)">
                <input type="number" className={input} value={form.stop_loss_pct} min={0.1} step={0.1}
                  onChange={(e) => set({ stop_loss_pct: Number(e.target.value) || 1 })} />
              </Field>
              <Field label="Size (% of account)">
                <input type="number" className={input} value={Math.round(form.size_pct * 10) / 10} min={1} step={1}
                  onChange={(e) => set({ size_pct: Number(e.target.value) || 10 })} />
              </Field>
            </div>
            <p className="text-xs text-muted">
              A stop-out costs about {(form.size_pct * form.stop_loss_pct / 100).toFixed(2)}% of the account.{" "}
              <Link href="/strategies" className="underline">The strategy finder</Link> suggests sizes that fit your risk profile.
            </p>
            <Field label="Test on the past">
              <select className={input} value={form.years} onChange={(e) => set({ years: Number(e.target.value) })}>
                {(form.tf === "1h" ? [0.5, 1, 2] : [1, 3, 5, 10, 20]).map((y) => (
                  <option key={y} value={y}>Last {y < 1 ? "6 months" : `${y} year${y > 1 ? "s" : ""}`}</option>
                ))}
              </select>
            </Field>
            {error && <p className="text-sm text-down">{error}</p>}
            <button onClick={testPast} disabled={busy}
              className="w-full rounded-lg bg-gold py-2 font-medium text-black transition disabled:opacity-60">
              {busy ? "Working…" : "Test on the past"}
            </button>
            <button onClick={() => act(() => api.agentStart(config))} disabled={busy || running}
              title={running ? "Stop the running agent first" : undefined}
              className="w-full rounded-lg border border-gold py-2 text-sm font-medium text-gold transition hover:bg-gold/10 disabled:opacity-50">
              {running ? "Agent is running" : "Start on paper"}
            </button>
            <p className="text-xs leading-relaxed text-muted">
              The agent checks each new {form.tf === "1h" ? "hourly" : "daily"} candle and opens, closes or flips one position in your
              paper account when the strategy&apos;s signal changes, with the stop set for you. Virtual money only; nothing here is
              advice to trade.
            </p>
          </div>
        </aside>

        <section className="min-w-0 space-y-6">
          {state?.agent ? <LiveCard s={state} act={act} busy={busy} /> : (
            <Empty icon="assistant" title="No agent running">
              Test a strategy on the past to see what went wrong and which fixes helped, then press Start on paper to let the agent trade it live.
            </Empty>
          )}

          <div ref={results} className="scroll-mt-20 space-y-4">
            {past && base && (
              <>
                <h2 className="font-medium">
                  Past test: {strategies.find((s) => s.key === past.config.strategy)?.label}, last {past.years < 1 ? "6 months" : `${past.years} years`}
                </h2>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Per year">{ret(past.stats.cagr_pct ?? past.stats.total_return_pct)}</Stat>
                  <Stat label="Largest fall"><span className="text-down">{fmtPct(past.stats.max_drawdown_pct)}</span></Stat>
                  <Stat label="Trades">{past.stats.trades}</Stat>
                  <Stat label="Win rate">{fmtPct(past.stats.win_rate_pct)}</Stat>
                </div>
                <div className="overflow-hidden rounded-2xl border border-border"><EquityChart equity={past.equity} height={240} /></div>

                <div>
                  <h3 className="mb-2 text-sm font-medium">What went wrong</h3>
                  <Findings d={past.diagnosis} />
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium">Results by kind of market</h3>
                  <ByMarket d={past.diagnosis} />
                </div>
                <WorstPeriod d={past.diagnosis} />

                {past.fixes.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium">Fixes tested on the same prices</h3>
                    <p className="mb-2 text-xs text-muted">Each fix is re-run on the whole test and on its last 30% alone. A fix that only helps on the whole test may just fit the past.</p>
                    <div className="overflow-x-auto rounded-2xl border border-border">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead className="bg-surface text-left text-xs text-muted">
                          <tr>
                            <th className="px-3 py-2">Fix</th>
                            <th className="px-3 py-2 text-right">Per year</th>
                            <th className="px-3 py-2 text-right">Largest fall</th>
                            <th className="px-3 py-2 text-right">Whole test</th>
                            <th className="px-3 py-2 text-right">Last 30%</th>
                            <th className="px-3 py-2" />
                          </tr>
                        </thead>
                        <tbody>{past.fixes.map((f) => <FixRow key={f.title} f={f} base={base} use={use} />)}</tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <Coach hasData={!!(past || state?.last_past_test || state?.live?.stats.trades)} />
        </section>
      </div>
    </div>
  );
}
