"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import EquityChart from "@/components/EquityChart";
import SignInPrompt from "@/components/SignInPrompt";
import { Empty, PageHeader } from "@/components/ui";
import {
  api, fmtPct, type Backtest, type Condition, type CustomCatalog, type IndicatorSpec, type Operand, type Rules, type SavedStrategy,
} from "@/lib/api";
import { useUser } from "@/lib/useUser";

const input = "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-gold";
const GROUPS: { key: keyof Omit<Rules, "name">; title: string; hint: string; tone: string }[] = [
  { key: "long_entry", title: "Buy (go long) when", hint: "All of these are true on a candle's close", tone: "text-up" },
  { key: "long_exit", title: "Close the long when", hint: "Optional. A sell signal also closes it", tone: "text-up" },
  { key: "short_entry", title: "Sell (go short) when", hint: "Optional. Leave empty for a long-only strategy", tone: "text-down" },
  { key: "short_exit", title: "Close the short when", hint: "Optional. A buy signal also closes it", tone: "text-down" },
];
const EMPTY: Rules = { name: "My strategy", long_entry: [], long_exit: [], short_entry: [], short_exit: [] };

function defaults(spec: IndicatorSpec | undefined, ind: string, value?: number): Operand {
  return { ind, n: spec?.n?.default ?? null, m: spec?.m?.default ?? null, value: ind === "value" ? (value ?? 50) : null };
}

/** The rules as a sentence, matching what the API stores in the description. */
function sentence(r: Rules, cat: CustomCatalog): string {
  const spec = (k: string) => cat.indicators.find((i) => i.key === k);
  const op = (o: Operand) => {
    if (o.ind === "value") return String(o.value ?? "");
    const args = [o.n, o.m].filter((v) => v != null);
    return `${spec(o.ind)?.label ?? o.ind}${args.length ? ` (${args.join(", ")})` : ""}`;
  };
  const opl = (k: Condition["op"]) => cat.ops.find((o) => o.key === k)?.label ?? k;
  const group = (cs: Condition[]) => cs.map((c) => `${op(c.left)} ${opl(c.op)} ${op(c.right)}`).join(" and ");
  return (["long", "short"] as const)
    .filter((s) => r[`${s}_entry`].length)
    .map((s) => `${s === "long" ? "Buy" : "Sell short"} when ${group(r[`${s}_entry`])}${r[`${s}_exit`].length ? `; close it when ${group(r[`${s}_exit`])}` : ""}.`)
    .join(" ");
}

function OperandPicker({ o, cat, onChange, allowNumber }: { o: Operand; cat: CustomCatalog; onChange: (o: Operand) => void; allowNumber: boolean }) {
  const spec = cat.indicators.find((i) => i.key === o.ind);
  const groups = [...new Set(cat.indicators.map((i) => i.group))].filter((g) => allowNumber || g !== "Number");
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <select className={input} value={o.ind} aria-label="Indicator"
        onChange={(e) => onChange(defaults(cat.indicators.find((i) => i.key === e.target.value), e.target.value))}>
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {cat.indicators.filter((i) => i.group === g).map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
          </optgroup>
        ))}
      </select>
      {o.ind === "value" ? (
        <input type="number" className={input} value={o.value ?? ""} step="any" aria-label="Number"
          onChange={(e) => onChange({ ...o, value: e.target.value === "" ? null : Number(e.target.value) })} />
      ) : (spec?.n || spec?.m) && (
        <div className="flex gap-1.5">
          {(["n", "m"] as const).map((k) => spec?.[k] && (
            <label key={k} className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted">
              <span className="shrink-0">{spec[k]!.label}</span>
              <input type="number" className={`${input} py-1`} value={o[k] ?? ""} min={1} step="any"
                onChange={(e) => onChange({ ...o, [k]: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function ConditionRow({ c, cat, onChange, onRemove }: { c: Condition; cat: CustomCatalog; onChange: (c: Condition) => void; onRemove: () => void }) {
  return (
    <div className="rise-in flex flex-col gap-2 rounded-xl border border-border bg-background/60 p-2.5 sm:flex-row sm:items-start">
      <OperandPicker o={c.left} cat={cat} allowNumber={false} onChange={(left) => onChange({ ...c, left })} />
      <select className={`${input} sm:w-36`} value={c.op} aria-label="Comparison" onChange={(e) => onChange({ ...c, op: e.target.value as Condition["op"] })}>
        {cat.ops.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      <OperandPicker o={c.right} cat={cat} allowNumber onChange={(right) => onChange({ ...c, right })} />
      <button type="button" onClick={onRemove} aria-label="Remove condition"
        className="self-end rounded-lg p-1.5 text-muted transition-colors hover:text-down sm:self-start">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

export default function BuilderPage() {
  const { user } = useUser();
  const [cat, setCat] = useState<CustomCatalog | null>(null);
  const [mine, setMine] = useState<SavedStrategy[]>([]);
  const [rules, setRules] = useState<Rules>(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<{ tf: "1d" | "1h"; years: number; stop: number | null }>({ tf: "1d", years: 10, stop: 3 });
  const [result, setResult] = useState<Backtest | null>(null);

  useEffect(() => {
    api.customCatalog().then((c) => {
      setCat(c);
      setRules(c.templates[0] ? { ...c.templates[0].rules, name: "My strategy" } : EMPTY);
    });
  }, []);
  useEffect(() => {
    if (user) api.customList().then(setMine, () => {});
  }, [user]);

  const text = useMemo(() => (cat ? sentence(rules, cat) : ""), [rules, cat]);
  if (user === null) return <SignInPrompt what="build your own strategies" next="/strategies/builder" />;
  if (!user || !cat) return null;

  const setGroup = (k: keyof Omit<Rules, "name">, list: Condition[]) => {
    setRules({ ...rules, [k]: list });
    setResult(null);
  };
  const newCondition = (): Condition => ({
    left: defaults(cat.indicators.find((i) => i.key === "close"), "close"),
    op: ">",
    right: defaults(cat.indicators.find((i) => i.key === "sma"), "sma"),
  });

  async function guard<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
    setBusy(true);
    setMsg(null);
    try {
      const v = await fn();
      if (ok) setMsg({ ok: true, text: ok });
      return v;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Something went wrong" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const s = await guard(() => api.customSave(rules, editing ?? undefined), editing ? "Saved your changes" : "Saved to your strategies");
    if (s) {
      setEditing(s.id);
      setMine(await api.customList());
    }
  }

  async function runTest() {
    const start = new Date(Date.now() - test.years * 365.25 * 864e5).toISOString().slice(0, 10);
    const r = await guard(() => api.runBacktest({
      strategy: "custom", params: {}, rules, tf: test.tf, start, end: null, direction: "both", capital: 10000, units: 1,
      spread: 0.3, swap_long: -0.25, swap_short: 0.05, stop_loss_pct: test.stop, take_profit_pct: null, size_pct: 100,
    }));
    if (r) setResult(r);
  }

  function load(s: SavedStrategy) {
    setRules(s.rules);
    setEditing(s.id);
    setResult(null);
    setMsg(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const st = result?.stats;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader icon="bolt" title="Strategy builder"
        subtitle="Combine indicators into your own rules for buying, selling and closing. Test them on past prices, then use them in the backtester, the strategy finder and the agent." />

      <div className="mt-6">
        <p className="text-sm font-medium">Start from an idea</p>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {cat.templates.map((t) => (
            <button key={t.key} type="button" title={t.summary}
              onClick={() => { setRules({ ...t.rules, name: t.name }); setEditing(null); setResult(null); setMsg(null); }}
              className="shrink-0 rounded-full border border-border px-3.5 py-1.5 text-sm transition-colors hover:border-gold/60 hover:text-gold">
              {t.name}
            </button>
          ))}
          <button type="button" onClick={() => { setRules(EMPTY); setEditing(null); setResult(null); }}
            className="shrink-0 rounded-full border border-dashed border-border px-3.5 py-1.5 text-sm text-muted transition-colors hover:text-foreground">
            Start blank
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <label className="block">
            <span className="text-sm text-muted">Name</span>
            <input className={`${input} mt-1 text-base font-medium`} value={rules.name} maxLength={60}
              onChange={(e) => setRules({ ...rules, name: e.target.value })} />
          </label>

          {GROUPS.map((g) => (
            <section key={g.key} className="card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className={`font-semibold ${g.tone}`}>{g.title}</h2>
                <span className="text-xs text-muted">{g.hint}</span>
              </div>
              <div className="mt-3 space-y-2">
                {rules[g.key].map((c, i) => (
                  <div key={i}>
                    {i > 0 && <p className="py-1 text-center text-[11px] font-medium uppercase tracking-wider text-muted">and</p>}
                    <ConditionRow c={c} cat={cat}
                      onChange={(n) => setGroup(g.key, rules[g.key].map((x, j) => (j === i ? n : x)))}
                      onRemove={() => setGroup(g.key, rules[g.key].filter((_, j) => j !== i))} />
                  </div>
                ))}
                {rules[g.key].length < cat.max_conditions && (
                  <button type="button" onClick={() => setGroup(g.key, [...rules[g.key], newCondition()])}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-sm text-muted transition-colors hover:border-gold/50 hover:text-gold">
                    + Add a condition
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="card space-y-3 p-4">
            <h2 className="font-semibold">In plain words</h2>
            <p className="text-sm leading-relaxed text-muted">{text || "Add a condition for buying or selling to begin."}</p>
            <p className="text-xs text-muted">Signals are read on each candle&apos;s close and filled at the next open, like every backtest here.</p>
            <button type="button" onClick={save} disabled={busy}
              className="w-full rounded-full bg-gradient-to-b from-[#f2c95a] to-gold py-2.5 text-sm font-semibold text-black transition-[filter] hover:brightness-105 disabled:opacity-60">
              {editing ? "Save changes" : "Save strategy"}
            </button>
            {editing && (
              <div className="grid grid-cols-2 gap-2 text-sm">
                <Link href={`/backtest?custom=${editing}`} className="rounded-full border border-border py-2 text-center transition-colors hover:border-gold/50">Full backtest</Link>
                <Link href={`/paper/agent?custom=${editing}`} className="rounded-full border border-border py-2 text-center transition-colors hover:border-gold/50">Run as agent</Link>
              </div>
            )}
            {msg && <p className={`text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}
          </div>

          <div className="card space-y-3 p-4">
            <h2 className="font-semibold">Quick test</h2>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <label className="text-muted">Candles
                <select className={`${input} mt-1`} value={test.tf}
                  onChange={(e) => { const tf = e.target.value as "1d" | "1h"; setTest({ ...test, tf, years: tf === "1h" ? 2 : 10 }); }}>
                  <option value="1d">Daily</option><option value="1h">Hourly</option>
                </select>
              </label>
              <label className="text-muted">Years
                <select className={`${input} mt-1`} value={test.years} onChange={(e) => setTest({ ...test, years: Number(e.target.value) })}>
                  {(test.tf === "1h" ? [1, 2] : [3, 5, 10, 20]).map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>
              <label className="text-muted">Stop %
                <input type="number" className={`${input} mt-1`} value={test.stop ?? ""} min={0.1} step="any" placeholder="none"
                  onChange={(e) => setTest({ ...test, stop: e.target.value === "" ? null : Number(e.target.value) })} />
              </label>
            </div>
            <button type="button" onClick={runTest} disabled={busy}
              className="w-full rounded-full border border-border bg-surface-2 py-2 text-sm font-medium transition-colors hover:border-gold/60 disabled:opacity-60">
              {busy ? "Working…" : "Test on past prices"}
            </button>
            <p className="text-xs text-muted">$10,000, each trade the size of the account (no leverage), with spread and swap.</p>
            {st && (
              <div className="rise-in space-y-3">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {[["Return", fmtPct(st.total_return_pct)], ["Worst drop", fmtPct(st.max_drawdown_pct)],
                    ["Trades", String(st.trades)], ["Winners", st.win_rate_pct == null ? "–" : `${st.win_rate_pct.toFixed(0)}%`]].map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-background p-2">
                      <p className="text-[11px] uppercase tracking-wider text-muted">{k}</p>
                      <p className="font-semibold tabular-nums">{v}</p>
                    </div>
                  ))}
                </div>
                <EquityChart equity={result!.equity} height={160} />
                <p className="text-xs text-muted">Owning gold over the same days: {fmtPct(st.buy_and_hold_pct)}. Past results don&apos;t predict future ones.</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Your strategies</h2>
        {mine.length === 0 ? (
          <div className="mt-3"><Empty icon="bolt" title="Nothing saved yet">Build a strategy above and save it to use it anywhere on the site.</Empty></div>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {mine.map((s) => (
              <div key={s.id} className={`card flex flex-col p-4 ${editing === s.id ? "border-gold/50" : ""}`}>
                <p className="font-semibold">{s.name}</p>
                <p className="mt-1 flex-1 text-sm leading-relaxed text-muted">{s.description}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-sm">
                  <button onClick={() => load(s)} className="rounded-full border border-border px-3 py-1 transition-colors hover:border-gold/50">Edit</button>
                  <Link href={`/backtest?custom=${s.id}`} className="rounded-full border border-border px-3 py-1 transition-colors hover:border-gold/50">Backtest</Link>
                  <Link href={`/paper/agent?custom=${s.id}`} className="rounded-full border border-border px-3 py-1 transition-colors hover:border-gold/50">Run as agent</Link>
                  <button onClick={async () => {
                    if (await guard(() => api.customDelete(s.id), "Deleted")) {
                      setMine(mine.filter((x) => x.id !== s.id));
                      if (editing === s.id) setEditing(null);
                    }
                  }} className="ml-auto rounded-full px-3 py-1 text-muted transition-colors hover:text-down">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs text-muted">
          Your saved strategies also appear in the <Link href="/strategies" className="underline">strategy finder</Link>, which tries them with stops and sizes that fit your risk profile.
        </p>
      </section>
    </div>
  );
}
