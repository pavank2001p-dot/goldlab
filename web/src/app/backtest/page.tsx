"use client";

import { useEffect, useState } from "react";
import ReportView from "@/components/ReportView";
import SignInPrompt from "@/components/SignInPrompt";
import { api, fmtPct, type Backtest, type BacktestParams, type BacktestSummary, type Strategy } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const input = "w-full rounded-md border border-border bg-background px-3 py-1.5 outline-none focus:border-gold";

const DEFAULTS: Omit<BacktestParams, "strategy" | "params"> = {
  tf: "1d",
  start: "2015-01-01",
  end: null,
  direction: "both",
  capital: 10000,
  units: 5,
  spread: 0.3,
  swap_long: -0.25,
  swap_short: 0.05,
  stop_loss_pct: null,
  take_profit_pct: null,
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function Num({ value, onChange, step = "any", min, max, placeholder }: {
  value: number | null | undefined; onChange: (v: number | null) => void; step?: number | "any"; min?: number; max?: number; placeholder?: string;
}) {
  return (
    <input type="number" className={input} value={value ?? ""} step={step} min={min} max={max} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
  );
}

const label = (strategies: Strategy[], p: BacktestParams) => {
  const s = strategies.find((x) => x.key === p.strategy);
  return `${s?.label ?? p.strategy} (${Object.values(p.params).join("/")}) · ${p.tf === "1h" ? "hourly" : "daily"}`;
};

export default function BacktestPage() {
  const { user } = useUser();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [form, setForm] = useState<BacktestParams | null>(null);
  const [result, setResult] = useState<Backtest | null>(null);
  const [history, setHistory] = useState<BacktestSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.strategies().then((list) => {
      setStrategies(list);
      const s = list[0];
      setForm({ ...DEFAULTS, strategy: s.key, params: Object.fromEntries(s.params.map((p) => [p.key, p.default])) });
    });
  }, []);
  useEffect(() => {
    if (user) api.backtests().then(setHistory, () => {});
  }, [user]);

  if (user === null) return <SignInPrompt what="backtest strategies on gold" next="/backtest" />;
  if (!form || user === undefined) return null;

  const strategy = strategies.find((s) => s.key === form.strategy)!;
  const set = (patch: Partial<BacktestParams>) => setForm({ ...form, ...patch });

  function pick(key: string) {
    const s = strategies.find((x) => x.key === key)!;
    set({ strategy: key, params: Object.fromEntries(s.params.map((p) => [p.key, p.default])) });
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.runBacktest({ ...form!, end: form!.end || null });
      setResult(r);
      // On narrow screens the results sit below the form.
      if (window.innerWidth < 1024) setTimeout(() => document.getElementById("results")?.scrollIntoView({ behavior: "smooth" }), 50);
      setHistory(await api.backtests());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setBusy(false);
    }
  }

  async function open(id: number) {
    const r = await api.backtest(id);
    setResult(r);
    setForm({ ...r.params, end: r.params.end ?? null });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(id: number) {
    await api.deleteBacktest(id);
    setHistory(history.filter((h) => h.id !== id));
    if (result?.id === id) setResult(null);
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[320px_1fr]">
      <form onSubmit={run} className="space-y-4">
        <h1 className="text-xl font-semibold">Backtest a strategy</h1>
        <Field label="Strategy">
          <select className={input} value={form.strategy} onChange={(e) => pick(e.target.value)}>
            {strategies.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <p className="text-xs text-muted">{strategy.summary}</p>
        {strategy.params.map((p) =>
          p.min === 0 && p.max === 1 && p.step === 1 ? (
            <label key={p.key} className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={!!form.params[p.key]} className="accent-[var(--gold)]"
                onChange={(e) => set({ params: { ...form.params, [p.key]: e.target.checked ? 1 : 0 } })} />
              {p.label.replace(" (1 = yes)", "")}
            </label>
          ) : (
            <Field key={p.key} label={p.label}>
              <Num value={form.params[p.key]} step={p.step} min={p.min} max={p.max}
                onChange={(v) => set({ params: { ...form.params, [p.key]: v ?? p.default } })} />
            </Field>
          ),
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Candles">
            <select className={input} value={form.tf} onChange={(e) => set({ tf: e.target.value as "1h" | "1d" })}>
              <option value="1d">Daily</option>
              <option value="1h">Hourly</option>
            </select>
          </Field>
          <Field label="Trade">
            <select className={input} value={form.direction} onChange={(e) => set({ direction: e.target.value as BacktestParams["direction"] })}>
              <option value="both">Long and short</option>
              <option value="long_only">Long only</option>
              <option value="short_only">Short only</option>
            </select>
          </Field>
          <Field label="From">
            <input type="date" className={input} value={form.start} min="2010-01-01" onChange={(e) => set({ start: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" className={input} value={form.end ?? ""} onChange={(e) => set({ end: e.target.value || null })} />
          </Field>
        </div>

        <details className="rounded-lg border border-border p-3" open>
          <summary className="cursor-pointer text-sm font-medium">Money and risk</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Starting capital ($)"><Num value={form.capital} min={1} onChange={(v) => set({ capital: v ?? 10000 })} /></Field>
            <Field label="Ounces per trade" hint="1 lot = 100 oz"><Num value={form.units} min={0.01} onChange={(v) => set({ units: v ?? 1 })} /></Field>
            <Field label="Stop loss (%)"><Num value={form.stop_loss_pct} min={0.1} placeholder="none" onChange={(v) => set({ stop_loss_pct: v })} /></Field>
            <Field label="Take profit (%)"><Num value={form.take_profit_pct} min={0.1} placeholder="none" onChange={(v) => set({ take_profit_pct: v })} /></Field>
          </div>
        </details>
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Broker costs</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Spread ($/oz)"><Num value={form.spread} min={0} onChange={(v) => set({ spread: v ?? 0 })} /></Field>
            <div />
            <Field label="Swap long ($/oz/night)"><Num value={form.swap_long} onChange={(v) => set({ swap_long: v ?? 0 })} /></Field>
            <Field label="Swap short ($/oz/night)"><Num value={form.swap_short} onChange={(v) => set({ swap_short: v ?? 0 })} /></Field>
          </div>
          <p className="mt-2 text-xs text-muted">Defaults are rough estimates. Check your broker&apos;s spread and swap rates for gold.</p>
        </details>

        {error && <p className="text-sm text-down">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-gold py-2 font-medium text-black disabled:opacity-60">
          {busy ? "Running…" : "Run backtest"}
        </button>
        <p className="text-xs text-muted">
          Signals use each candle&apos;s close and trade at the next candle&apos;s open. Past results don&apos;t predict future ones.
        </p>
      </form>

      <section id="results" className="min-w-0 space-y-6">
        {result ? (
          <div>
            <h2 className="mb-3 font-medium">{label(strategies, result.params)}</h2>
            <ReportView report={result} kind="backtest" />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted">
            Pick a strategy and press Run to see its equity curve, drawdown, trades and statistics.
          </div>
        )}
        {history.length > 0 && (
          <div>
            <h2 className="mb-2 font-medium">Your backtests</h2>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm tabular-nums">
                <thead className="bg-surface text-left text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2">Strategy</th>
                    <th className="px-3 py-2 text-right">Return</th>
                    <th className="px-3 py-2 text-right">Max DD</th>
                    <th className="px-3 py-2 text-right">Trades</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className={`border-t border-border ${result?.id === h.id ? "bg-surface" : ""}`}>
                      <td className="px-3 py-1.5">
                        <button onClick={() => open(h.id)} className="text-left hover:text-gold">{label(strategies, h.params)}</button>
                      </td>
                      <td className={`px-3 py-1.5 text-right ${(h.stats.total_return_pct ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                        {fmtPct(h.stats.total_return_pct)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-down">{fmtPct(h.stats.max_drawdown_pct)}</td>
                      <td className="px-3 py-1.5 text-right">{h.stats.trades}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button onClick={() => remove(h.id)} className="text-xs text-muted hover:text-down">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
