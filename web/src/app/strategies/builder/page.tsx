"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import SignInPrompt from "@/components/SignInPrompt";
import ShareButton, { resultShare } from "@/components/ShareCard";
import DescribeBox from "@/components/studio/DescribeBox";
import TunePanel from "@/components/studio/TunePanel";
import TradeChart from "@/components/TradeChart";
import { CountUp, Icon } from "@/components/ui";
import {
  api, type Condition, type CustomCatalog, type CustomPreview, type IndicatorSpec, type Operand, type Rules, type SavedStrategy,
} from "@/lib/api";
import { clampOperand, mRange, nRange, sanitizeRules } from "@/lib/ruleBounds";
import { useUser } from "@/lib/useUser";

type Lane = keyof Omit<Rules, "name">;
const LANES: { key: Lane; title: string; hint: string; icon: string; tone: "up" | "down"; exit: boolean }[] = [
  { key: "long_entry", title: "Buy when", hint: "Opens a long trade", icon: "up", tone: "up", exit: false },
  { key: "long_exit", title: "Close the buy when", hint: "Optional. A sell signal also closes it", icon: "check", tone: "up", exit: true },
  { key: "short_entry", title: "Sell short when", hint: "Optional. Leave empty for buys only", icon: "down", tone: "down", exit: false },
  { key: "short_exit", title: "Close the short when", hint: "Optional. A buy signal also closes it", icon: "check", tone: "down", exit: true },
];
// A colour per indicator family, so a rule reads at a glance.
const TINT: Record<string, string> = {
  Price: "#9aa5b1", Trend: "var(--gold)", Momentum: "var(--calm)", Volatility: "#c084fc", Number: "var(--foreground)",
};
const TAGS: Record<string, string> = {
  golden_cross: "Trend", rsi_dip_uptrend: "Pullback", strong_trend_breakout: "Breakout", macd_trend_filter: "Momentum", band_fade: "Reversion",
};
const TEMPLATE_ICON: Record<string, string> = {
  golden_cross: "backtest", rsi_dip_uptrend: "drop", strong_trend_breakout: "bolt", macd_trend_filter: "layers", band_fade: "scale",
};
const EMPTY: Rules = { name: "My strategy", long_entry: [], long_exit: [], short_entry: [], short_exit: [] };

function defaults(spec: IndicatorSpec | undefined, ind: string): Operand {
  return { ind, n: spec?.n?.default ?? null, m: spec?.m?.default ?? null, value: ind === "value" ? 50 : null };
}

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

const chevron = "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%238f99a5%22 stroke-width=%222.5%22><path d=%22M6 9l6 6 6-6%22/></svg>')] bg-[length:12px] bg-[right_10px_center] bg-no-repeat";

/** One side of a condition, drawn as a coloured token with its settings inline. */
function Token({ o, cat, onChange, allowNumber }: { o: Operand; cat: CustomCatalog; onChange: (o: Operand) => void; allowNumber: boolean }) {
  const spec = cat.indicators.find((i) => i.key === o.ind);
  const tint = TINT[spec?.group ?? "Price"];
  const groups = [...new Set(cat.indicators.map((i) => i.group))].filter((g) => allowNumber || g !== "Number");
  const num = (k: "n" | "m" | "value", label: string, w = "w-14") => (
    <input type="number" aria-label={label} title={label} value={o[k] ?? ""} step="any"
      min={k === "n" ? nRange(o.ind)[0] : k === "m" ? mRange(o.ind)[0] : undefined}
      max={k === "n" ? nRange(o.ind)[1] : k === "m" ? mRange(o.ind)[1] : undefined}
      onChange={(e) => onChange({ ...o, [k]: e.target.value === "" ? null : Number(e.target.value) })}
      onBlur={() => onChange(clampOperand(o))}
      className={`${w} rounded-md border border-border bg-background px-1.5 py-1 text-center text-sm tabular-nums outline-none focus:border-gold`} />
  );
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-xl border bg-surface-2 py-1 pl-1 pr-1.5"
      style={{ borderColor: `color-mix(in srgb, ${tint} 45%, transparent)` }}>
      <span className="ml-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: tint }} />
      <select value={o.ind} aria-label="Indicator"
        onChange={(e) => onChange(defaults(cat.indicators.find((i) => i.key === e.target.value), e.target.value))}
        className={`min-w-0 max-w-[20rem] appearance-none [field-sizing:content] rounded-lg bg-transparent py-1 pl-1 pr-7 text-sm font-medium outline-none ${chevron}`}>
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {cat.indicators.filter((i) => i.group === g).map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
          </optgroup>
        ))}
      </select>
      {o.ind === "value" ? num("value", "Number", "w-20") : (
        <>
          {spec?.n && num("n", spec.n.label)}
          {spec?.m && num("m", spec.m.label)}
        </>
      )}
    </span>
  );
}

function Rule({ c, i, cat, onChange, onRemove }: { c: Condition; i: number; cat: CustomCatalog; onChange: (c: Condition) => void; onRemove: () => void }) {
  return (
    <div className="rise-in group flex items-start gap-3">
      <span className={`mt-1.5 w-10 shrink-0 rounded-md py-0.5 text-center text-[10px] font-bold tracking-widest ${i ? "bg-surface-2 text-muted" : "bg-gold/15 text-gold"}`}>
        {i ? "AND" : "IF"}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Token o={c.left} cat={cat} allowNumber={false} onChange={(left) => onChange({ ...c, left })} />
        <select value={c.op} aria-label="Comparison" onChange={(e) => onChange({ ...c, op: e.target.value as Condition["op"] })}
          className={`appearance-none rounded-full border border-border bg-background py-1.5 pl-3 pr-8 text-sm italic text-muted outline-none focus:border-gold ${chevron}`}>
          {cat.ops.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <Token o={c.right} cat={cat} allowNumber onChange={(right) => onChange({ ...c, right })} />
      </div>
      <button type="button" onClick={onRemove} aria-label="Remove condition"
        className="mt-1 rounded-lg p-1.5 text-muted opacity-60 transition hover:bg-down/10 hover:text-down group-hover:opacity-100">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

function Stat({ label, value, format, tone }: { label: string; value: number | null | undefined; format: (v: number) => string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-background/60 p-3">
      <p className="text-[10px] font-medium uppercase tracking-widest text-muted">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${tone ?? ""}`}>{value == null ? "–" : <CountUp value={value} format={format} />}</p>
    </div>
  );
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

export default function BuilderPage() {
  const { user } = useUser();
  const [cat, setCat] = useState<CustomCatalog | null>(null);
  const [mine, setMine] = useState<SavedStrategy[]>([]);
  const [rules, setRules] = useState<Rules>(EMPTY);
  const [template, setTemplate] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<{ tf: "1d" | "1h"; years: number; stop: number | null }>({ tf: "1d", years: 5, stop: 3 });
  const [live, setLive] = useState<CustomPreview | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const seq = useRef(0);
  const opened = useRef(false); // a saved strategy opened from a link, which the starting template mustn't replace

  useEffect(() => {
    api.customCatalog().then((c) => {
      setCat(c);
      const t = c.templates[2] ?? c.templates[0];
      if (t && !opened.current) {
        setRules({ ...t.rules, name: t.name });
        setTemplate(t.key);
      }
    });
  }, []);
  useEffect(() => {
    if (!user) return;
    api.customList().then((list) => {
      setMine(list);
      // The assistant links here with ?id=<saved strategy> after it builds one.
      const id = Number(new URLSearchParams(window.location.search).get("id"));
      const s = id ? list.find((x) => x.id === id) : undefined;
      if (s) {
        opened.current = true;
        setRules(sanitizeRules(s.rules));
        setTemplate(null);
        setEditing(s.id);
      }
    }, () => {});
  }, [user]);

  // Re-test shortly after every change, so the chart follows the rules as they are written.
  const ready = rules.long_entry.length + rules.short_entry.length > 0;
  useEffect(() => {
    if (!user || !cat || !ready) return;
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api.customPreview({ rules, tf: test.tf, years: test.years, stop_loss_pct: test.stop })
        .then((r) => { if (id === seq.current) { setLive(r); setLiveErr(null); } })
        .catch((e) => { if (id === seq.current) setLiveErr(e instanceof Error ? e.message : "Couldn't test these rules"); })
        .finally(() => { if (id === seq.current) setLoading(false); });
    }, 650);
    return () => clearTimeout(t);
  }, [rules, test, user, cat, ready]);

  const text = useMemo(() => (cat ? sentence(rules, cat) : ""), [rules, cat]);
  if (user === null) return <SignInPrompt what="build your own strategies" next="/strategies/builder" />;
  if (!user || !cat) return null;

  const setLane = (k: Lane, list: Condition[]) => setRules({ ...rules, [k]: list });
  const newCondition = (exit: boolean): Condition => exit
    ? { left: defaults(undefined, "close"), op: "<", right: defaults(cat.indicators.find((i) => i.key === "sma"), "sma") }
    : { left: defaults(cat.indicators.find((i) => i.key === "rsi"), "rsi"), op: "<", right: { ind: "value", value: 30 } };

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
    const s = await guard(() => api.customSave(rules, editing ?? undefined), editing ? "Changes saved" : "Saved to your strategies");
    if (s) {
      setEditing(s.id);
      setMine(await api.customList());
    }
  }

  function start(r: Rules, key: string | null, id: number | null = null) {
    setNote(null);
    setRules(sanitizeRules(r));
    setTemplate(key);
    setEditing(id);
    setMsg(null);
  }

  /** A random idea with its numbers nudged, for playing around. */
  function surprise() {
    const t = cat!.templates[Math.floor(Math.random() * cat!.templates.length)];
    const jig = (o: Operand): Operand => ({
      ...o,
      n: o.n != null && !o.ind.startsWith("macd") ? Math.max(2, Math.round(o.n * (0.6 + Math.random() * 0.8))) : o.n,
      value: o.value != null && o.ind === "value" ? Math.round(o.value * (0.8 + Math.random() * 0.4)) : o.value,
    });
    const r = structuredClone(t.rules);
    for (const l of LANES) r[l.key] = r[l.key].map((c) => ({ ...c, left: jig(c.left), right: jig(c.right) }));
    start({ ...r, name: `${t.name}, remixed` }, t.key);
  }

  const st = live?.stats;
  const hold = st?.buy_and_hold_pct ?? null;
  const ret = st?.total_return_pct ?? null;
  const scale = Math.max(Math.abs(ret ?? 0), Math.abs(hold ?? 0), 1);
  const count = LANES.reduce((n, l) => n + rules[l.key].length, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-gold/25 bg-gradient-to-br from-surface-2 via-surface to-background p-6 sm:p-10">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-gold/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 left-1/3 h-64 w-64 rounded-full bg-calm/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--foreground)_3%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--foreground)_3%,transparent)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_75%)]" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-gold">
            <Icon name="bolt" className="h-3.5 w-3.5" /> Strategy studio
          </span>
          <h1 className="mt-4 max-w-3xl text-3xl font-bold tracking-tight sm:text-5xl">
            Design a strategy.{" "}
            <span className="bg-gradient-to-r from-gold via-gold-hi to-gold bg-clip-text text-transparent">Watch it trade.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-muted">
            Snap indicators together into rules. Every change is tested on real gold prices in a moment, with each buy and
            sell drawn on the chart.
          </p>
          <ol className="mt-7 flex flex-wrap gap-x-8 gap-y-3 text-sm">
            {["Pick an idea", "Shape the rules", "See every trade"].map((s, i) => (
              <li key={s} className="flex items-center gap-2.5">
                <span className="font-mono text-lg font-bold text-gold">0{i + 1}</span>
                <span className="text-foreground/90">{s}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <div className="mt-6">
        <DescribeBox onRules={(r, n) => { start(r, null); setNote(n); }} />
      </div>

      {/* Templates */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold">Start from an idea</h2>
          <div className="flex gap-4">
            <button type="button" onClick={surprise} className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-gold">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1.2" fill="currentColor" /><circle cx="15" cy="15" r="1.2" fill="currentColor" /><circle cx="15" cy="9" r="1.2" fill="currentColor" /><circle cx="9" cy="15" r="1.2" fill="currentColor" /></svg>
              Surprise me
            </button>
            <button type="button" onClick={() => start(EMPTY, null)} className="text-sm text-muted transition-colors hover:text-gold">Start blank</button>
          </div>
        </div>
        <div className="-mx-4 mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
          {cat.templates.map((t) => {
            const on = template === t.key;
            return (
              <button key={t.key} type="button" onClick={() => start({ ...t.rules, name: t.name }, t.key)}
                className={`group relative w-60 shrink-0 snap-start overflow-hidden rounded-2xl border p-4 text-left transition-colors ${on ? "border-gold/70 bg-gold/10" : "border-border bg-surface hover:border-gold/40"}`}>
                <div className="flex items-center justify-between">
                  <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${on ? "bg-gold text-black" : "bg-gold/10 text-gold"}`}>
                    <Icon name={TEMPLATE_ICON[t.key] ?? "bolt"} className="h-4 w-4" />
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">{TAGS[t.key] ?? "Idea"}</span>
                </div>
                <p className="mt-3 font-semibold">{t.name}</p>
                <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">{t.summary}</p>
              </button>
            );
          })}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* Rules */}
        <div className="min-w-0 space-y-4">
          {note && (
            <div className="rise-in flex items-start gap-3 rounded-2xl border border-gold/30 bg-gold/10 p-4 text-sm">
              <Icon name="assistant" className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
              <p className="flex-1">{note}</p>
              <button type="button" onClick={() => setNote(null)} aria-label="Dismiss" className="text-muted hover:text-foreground">×</button>
            </div>
          )}
          <div className="flex items-center gap-3">
            <input value={rules.name} maxLength={60} aria-label="Strategy name" onChange={(e) => setRules({ ...rules, name: e.target.value })}
              className="min-w-0 flex-1 border-b border-transparent bg-transparent pb-1 text-2xl font-bold tracking-tight outline-none transition-colors hover:border-border focus:border-gold" />
            <span className="shrink-0 rounded-full bg-surface-2 px-3 py-1 text-xs text-muted">{count} condition{count === 1 ? "" : "s"}</span>
          </div>

          {LANES.map((l) => {
            const list = rules[l.key];
            const color = l.tone === "up" ? "var(--up)" : "var(--down)";
            return (
              <section key={l.key} className={`card relative overflow-hidden ${l.exit ? "ml-4 sm:ml-8" : ""}`}>
                <div aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: `linear-gradient(${color}, transparent)` }} />
                <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
                    <Icon name={l.icon} className="h-4 w-4" strokeWidth={2.4} />
                  </span>
                  <h3 className="font-semibold" style={{ color }}>{l.title}</h3>
                  <span className="ml-auto text-xs text-muted">{l.hint}</span>
                </div>
                <div className="space-y-3 px-5 py-4">
                  {list.length === 0 && <p className="text-sm text-muted/80">No conditions yet.</p>}
                  {list.map((c, i) => (
                    <Rule key={i} c={c} i={i} cat={cat}
                      onChange={(n) => setLane(l.key, list.map((x, j) => (j === i ? n : x)))}
                      onRemove={() => setLane(l.key, list.filter((_, j) => j !== i))} />
                  ))}
                  {list.length < cat.max_conditions && (
                    <button type="button" onClick={() => setLane(l.key, [...list, newCondition(l.exit)])}
                      className="ml-[3.25rem] inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1 text-sm text-muted transition-colors hover:border-gold/60 hover:text-gold">
                      <span className="text-base leading-none">+</span> {list.length ? "And…" : "Add a condition"}
                    </button>
                  )}
                </div>
              </section>
            );
          })}

          <div className="flex flex-wrap gap-4 px-1 text-xs text-muted">
            {Object.entries(TINT).filter(([g]) => g !== "Number").map(([g, c]) => (
              <span key={g} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{g}</span>
            ))}
            <span>Signals are read on each candle&apos;s close and filled at the next open.</span>
          </div>
          <TunePanel rules={rules} cat={cat} test={test} onChange={setRules} />
        </div>

        {/* Live preview */}
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
              <span className={`h-2 w-2 rounded-full ${loading ? "animate-pulse bg-gold" : live ? "breathe bg-up" : "bg-muted"}`} />
              <h2 className="font-semibold">Live preview</h2>
              <span className="ml-auto text-xs text-muted">{loading ? "Testing…" : live ? `${live.trades.length} trades` : ""}</span>
            </div>
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {(["1d", "1h"] as const).map((tf) => (
                <button key={tf} type="button" onClick={() => setTest({ ...test, tf, years: tf === "1h" ? 1 : 5 })}
                  className={`rounded-full px-2.5 py-1 text-xs transition-colors ${test.tf === tf ? "bg-gold text-black" : "bg-surface-2 text-muted hover:text-foreground"}`}>
                  {tf === "1d" ? "Daily" : "Hourly"}
                </button>
              ))}
              <span className="mx-1 w-px bg-border" />
              {(test.tf === "1h" ? [0.5, 1, 2] : [1, 3, 5, 10, 20]).map((y) => (
                <button key={y} type="button" onClick={() => setTest({ ...test, years: y })}
                  className={`rounded-full px-2.5 py-1 text-xs tabular-nums transition-colors ${test.years === y ? "bg-foreground text-background" : "bg-surface-2 text-muted hover:text-foreground"}`}>
                  {y < 1 ? "6M" : `${y}Y`}
                </button>
              ))}
              <label className="ml-auto flex items-center gap-1 text-xs text-muted">
                Stop
                <input type="number" value={test.stop ?? ""} min={0.1} step="any" placeholder="off" aria-label="Stop loss %"
                  onChange={(e) => setTest({ ...test, stop: e.target.value === "" ? null : Number(e.target.value) })}
                  className="w-12 rounded-md border border-border bg-background px-1.5 py-0.5 text-center tabular-nums outline-none focus:border-gold" />%
              </label>
            </div>
            <div className={`relative mt-2 transition-opacity duration-500 ${loading && live ? "opacity-50" : ""}`}>
              {!ready ? (
                <p className="px-4 py-16 text-center text-sm text-muted">Add a condition to <b>Buy when</b> or <b>Sell short when</b> to see it trade.</p>
              ) : liveErr && !live ? (
                <p className="px-4 py-16 text-center text-sm text-down">{liveErr}</p>
              ) : live ? (
                <TradeChart data={live} height={260} />
              ) : (
                <div className="mx-4 h-[260px] animate-pulse rounded-xl bg-surface-2" />
              )}
            </div>
            {st && ready && (
              <div className="space-y-3 p-4">
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Return" value={ret} format={pct} tone={(ret ?? 0) >= 0 ? "text-up" : "text-down"} />
                  <Stat label="Worst drop" value={st.max_drawdown_pct} format={(v) => `${v.toFixed(1)}%`} tone="text-down" />
                  <Stat label="Win rate" value={st.win_rate_pct} format={(v) => `${v.toFixed(0)}%`} />
                  <Stat label="In the market" value={live!.in_market_pct} format={(v) => `${v.toFixed(0)}%`} />
                </div>
                <div className="space-y-1.5 rounded-xl border border-border bg-background/60 p-3 text-xs">
                  {[["Your rules", ret, "var(--gold)"], ["Owning gold", hold, "var(--muted)"]].map(([l, v, c]) => (
                    <div key={l as string} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-muted">{l as string}</span>
                      <div className="relative h-2 flex-1 rounded-full bg-surface-2">
                        <div className="bar-grow absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(Math.abs((v as number) ?? 0) / scale, 1) * 100}%`, background: c as string, opacity: (v as number) < 0 ? 0.5 : 1 }} />
                      </div>
                      <span className="w-16 text-right font-semibold tabular-nums">{v == null ? "–" : pct(v as number)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-start gap-3">
                  <p className="flex-1 text-[11px] leading-relaxed text-muted">
                    $10,000, each trade the size of the account (no leverage), with spread and swap. Past results don&apos;t predict future ones.
                  </p>
                  <ShareButton className="shrink-0" data={resultShare("Strategy studio", rules.name || "My strategy",
                    `XAU/USD · ${test.tf === "1d" ? "daily" : "hourly"} candles · last ${test.years} year${test.years === 1 ? "" : "s"}${test.stop ? ` · ${test.stop}% stop` : ""}`,
                    st, live!.equity)} />
                </div>
              </div>
            )}
          </div>

          <div className="card space-y-3 p-4">
            <p className="text-xs font-medium uppercase tracking-widest text-muted">In plain words</p>
            <p className="text-sm leading-relaxed">{text || "Add a condition to begin."}</p>
            <button type="button" onClick={save} disabled={busy || !ready}
              className="w-full rounded-full bg-gradient-to-b from-gold-hi to-gold py-2.5 text-sm font-semibold text-black shadow-[0_10px_30px_-14px_var(--gold),inset_0_1px_0_rgb(255_255_255/0.35)] transition-[filter] hover:brightness-105 disabled:opacity-50">
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
        </aside>
      </div>

      {/* Library */}
      <section className="mt-12">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold">Your library</h2>
          <span className="text-xs text-muted">Also tried by the <Link href="/strategies" className="underline hover:text-foreground">strategy finder</Link></span>
        </div>
        {mine.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-border px-6 py-8 text-center text-sm text-muted">
            Strategies you save appear here, ready for the backtester, the finder and the agent.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {mine.map((s) => (
              <div key={s.id} className={`card flex flex-col p-4 transition-colors ${editing === s.id ? "border-gold/60" : "hover:border-gold/30"}`}>
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold/10 text-gold"><Icon name="bolt" className="h-4 w-4" /></span>
                  <p className="min-w-0 flex-1 truncate font-semibold">{s.name}</p>
                </div>
                <p className="mt-2 line-clamp-3 flex-1 text-xs leading-relaxed text-muted">{s.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                  <button onClick={() => { start(s.rules, null, s.id); window.scrollTo({ top: 300, behavior: "smooth" }); }}
                    className="rounded-full bg-surface-2 px-3 py-1 transition-colors hover:text-gold">Edit</button>
                  <Link href={`/backtest?custom=${s.id}`} className="rounded-full bg-surface-2 px-3 py-1 transition-colors hover:text-gold">Backtest</Link>
                  <Link href={`/paper/agent?custom=${s.id}`} className="rounded-full bg-surface-2 px-3 py-1 transition-colors hover:text-gold">Agent</Link>
                  <button onClick={async () => {
                    if (await guard(() => api.customDelete(s.id), "Deleted")) {
                      setMine(mine.filter((x) => x.id !== s.id));
                      if (editing === s.id) setEditing(null);
                    }
                  }} className="ml-auto rounded-full px-2 py-1 text-muted transition-colors hover:text-down">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
