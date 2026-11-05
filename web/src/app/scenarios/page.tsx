"use client";

import { useEffect, useRef, useState } from "react";
import SignInPrompt from "@/components/SignInPrompt";
import { PageHeader } from "@/components/ui";
import { api, type Scenario, type ScenarioInput } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const input = "w-full rounded-md border border-border bg-background px-3 py-1.5 outline-none focus:border-gold";
const HORIZONS = [
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "1 year", days: 365 },
];
const money = (v: number, sign = false) =>
  `${sign && v > 0 ? "+" : v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const price = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (t: number, year = false) =>
  new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// ---------------------------------------------------------------------------
// Range ("fan") chart: recent closes, then the simulated 5–95% and 25–75% ranges
// ---------------------------------------------------------------------------

function FanChart({ s, stop, target }: { s: Scenario; stop: number | null; target: number | null }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = 340, padL = 8, padR = 64, padT = 14, padB = 26;
  const recent = s.recent.slice(-60);
  const start0 = recent.length ? recent[recent.length - 1].t : s.bands[0].t;
  const t0 = recent.length ? recent[0].t : start0, t1 = s.bands[s.bands.length - 1].t;
  const vals = [...recent.map((r) => r.c), ...s.bands.flatMap((b) => [b.p5, b.p95]), s.entry, ...(stop ? [stop] : []), ...(target ? [target] : [])];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  // The past takes the left 40% of the width and the simulated future the rest, whatever the horizon.
  const split = padL + (w - padL - padR) * (recent.length ? 0.4 : 0);
  const x = (t: number) =>
    t <= start0
      ? padL + ((t - t0) / (start0 - t0 || 1)) * (split - padL)
      : split + ((t - start0) / (t1 - start0 || 1)) * (w - padR - split);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const start = { t: start0, v: s.entry };
  const band = (a: "p5" | "p25", b: "p95" | "p75") =>
    [`${x(start.t)},${y(start.v)}`, ...s.bands.map((p) => `${x(p.t)},${y(p[b])}`), ...[...s.bands].reverse().map((p) => `${x(p.t)},${y(p[a])}`)].join(" ");
  const line = (xs: { t: number; v: number }[]) => xs.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v)}`).join(" ");
  const levels = [s.entry, stop, target].filter((v): v is number => v != null);
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 5)
    .filter((v) => levels.every((l) => Math.abs(y(v) - y(l)) > 14)); // keep labels from overlapping
  const hb = hover !== null ? s.bands[hover] : null;

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px <= split) return setHover(null);
    const t = start0 + ((px - split) / (w - padR - split)) * (t1 - start0);
    let best = 0;
    s.bands.forEach((b, i) => { if (Math.abs(b.t - t) < Math.abs(s.bands[best].t - t)) best = i; });
    setHover(best);
  }

  const level = (v: number | null, label: string, colour: string) =>
    v ? (
      <g>
        <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke={colour} strokeDasharray="4 4" strokeWidth={1} />
        <text x={w - padR + 4} y={y(v) + 4} fontSize={10} fill={colour}>{label}</text>
      </g>
    ) : null;

  return (
    <div ref={ref} className="relative w-full">
      {w > 0 && <svg width={w} height={h} className="touch-none select-none" onPointerMove={move} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="var(--border)" />
            <text x={w - padR + 4} y={y(v) + 4} fontSize={10} fill="var(--muted)">{Math.round(v).toLocaleString()}</text>
          </g>
        ))}
        <line x1={x(start.t)} x2={x(start.t)} y1={padT} y2={h - padB} stroke="var(--border)" strokeDasharray="2 3" />
        <text x={x(start.t) - 4} y={h - 8} fontSize={10} fill="var(--muted)" textAnchor="end">Today</text>
        <text x={w - padR} y={h - 8} fontSize={10} fill="var(--muted)" textAnchor="end">{day(t1, true)}</text>
        <polygon points={band("p5", "p95")} fill="var(--gold)" fillOpacity={0.12} className="fan-in" />
        <polygon points={band("p25", "p75")} fill="var(--gold)" fillOpacity={0.22} className="fan-in" />
        <path d={line([start, ...s.bands.map((b) => ({ t: b.t, v: b.p50 }))])} fill="none" stroke="var(--gold)" strokeWidth={1.5} strokeDasharray="5 4" />
        <path d={line(recent.map((r) => ({ t: r.t, v: r.c })))} fill="none" stroke="var(--foreground)" strokeWidth={1.6} />
        {level(target, "Target", "var(--up)")}
        {level(stop, "Stop", "var(--down)")}
        {level(s.entry, "Entry", "var(--muted)")}
        {hb && (
          <g>
            <line x1={x(hb.t)} x2={x(hb.t)} y1={padT} y2={h - padB} stroke="var(--muted)" />
            {(["p5", "p25", "p50", "p75", "p95"] as const).map((k) => (
              <circle key={k} cx={x(hb.t)} cy={y(hb[k])} r={k === "p50" ? 3.5 : 2.5} fill="var(--gold)" />
            ))}
          </g>
        )}
      </svg>}
      {hb && (
        <div className="pointer-events-none absolute top-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(x(hb.t) + 12, 8), w - 190) }}>
          <p className="font-medium">{day(hb.t, true)}</p>
          <p className="mt-1 tabular-nums text-muted">9 in 10 paths: <span className="text-foreground">{price(hb.p5)} – {price(hb.p95)}</span></p>
          <p className="tabular-nums text-muted">Half of paths: <span className="text-foreground">{price(hb.p25)} – {price(hb.p75)}</span></p>
          <p className="tabular-nums text-muted">Middle path: <span className="text-gold">{price(hb.p50)}</span></p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-foreground" /> Past closes</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-sm bg-gold/40" /> Half of paths</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-sm bg-gold/15" /> 9 in 10 paths</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profit and loss histogram
// ---------------------------------------------------------------------------

function PnlHistogram({ s }: { s: Scenario }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const bins = s.pnl.histogram;
  const max = Math.max(...bins.map((b) => b.count));
  const h = 150, bw = w / bins.length;
  const hb = hover !== null ? bins[hover] : null;
  return (
    <div ref={ref} className="relative w-full">
      {w > 0 && <svg width={w} height={h} onPointerLeave={() => setHover(null)}>
        {bins.map((b, i) => {
          const bh = (b.count / max) * (h - 20);
          const mid = (b.from + b.to) / 2;
          return (
            <rect key={i} x={i * bw + 1} y={h - bh} width={Math.max(bw - 2, 1)} height={bh} rx={2}
              fill={mid >= 0 ? "var(--up)" : "var(--down)"} fillOpacity={hover === i ? 1 : 0.7}
              className="bar-rise" style={{ animationDelay: `${i * 15}ms` }}
              onPointerEnter={() => setHover(i)} />
          );
        })}
      </svg>}
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted">
        <span>{money(bins[0].from, true)}</span>
        <span>{money(bins[bins.length - 1].to, true)}</span>
      </div>
      {hb && (
        <div className="pointer-events-none absolute -top-2 right-0 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs tabular-nums">
          {money(hb.from, true)} to {money(hb.to, true)}: {((hb.count / s.paths) * 100).toFixed(1)}% of paths
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function OutcomeBar({ o }: { o: Scenario["outcomes"] }) {
  const parts = [
    { k: "target", label: "Hit the target first", v: o.target, c: "var(--up)" },
    { k: "stop", label: "Hit the stop first", v: o.stop, c: "var(--down)" },
    { k: "open", label: "Still open at the end", v: o.open, c: "var(--muted)" },
  ];
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-border">
        {parts.map((p) => p.v > 0 && <div key={p.k} className="bar-grow h-full" style={{ width: `${p.v}%`, background: p.c }} />)}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {parts.map((p) => (
          <div key={p.k}>
            <p className="text-xl font-semibold tabular-nums" style={{ color: p.c }}>{p.v.toFixed(0)}%</p>
            <p className="text-xs text-muted">{p.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ScenariosPage() {
  const { user } = useUser();
  const [form, setForm] = useState<ScenarioInput>({
    side: "long", entry: null, units: 1, stop: null, target: null, horizon_days: 30, lookback_years: 10, with_trend: false, capital: 10000,
  });
  const [stopPct, setStopPct] = useState<number | null>(2);
  const [targetPct, setTargetPct] = useState<number | null>(4);
  const [latest, setLatest] = useState<number | null>(null);
  const [s, setS] = useState<Scenario | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.summary().then((x) => x.price && setLatest(Math.round(x.price * 100) / 100), () => {});
  }, []);

  const entry = form.entry ?? latest;
  const dir = form.side === "long" ? 1 : -1;
  const stop = entry && stopPct ? Math.round(entry * (1 - (dir * stopPct) / 100) * 100) / 100 : null;
  const target = entry && targetPct ? Math.round(entry * (1 + (dir * targetPct) / 100) * 100) / 100 : null;
  const set = (p: Partial<ScenarioInput>) => setForm({ ...form, ...p });

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setS(await api.scenario({ ...form, entry, stop, target }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't run the scenario");
    } finally {
      setBusy(false);
    }
  }

  // Run once with the defaults as soon as the latest price is known.
  const ran = useRef(false);
  useEffect(() => {
    if (user && latest && !ran.current) {
      ran.current = true;
      run();
    }
  });

  if (user === null) return <SignInPrompt what="explore trade scenarios" next="/scenarios" />;
  if (user === undefined) return null;

  const riskOver = s?.profile && s.loss_at_stop_pct != null && s.loss_at_stop_pct > s.profile.max_risk_per_trade_pct;
  const levOver = s?.profile && s.leverage > s.profile.max_leverage;

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-8 lg:grid-cols-[320px_minmax(0,1fr)]">
      <form onSubmit={run} className="space-y-4">
        <PageHeader icon="scenarios" title="Trade scenarios" subtitle="See the range of outcomes gold's past moves make possible for a trade you open today." />

        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-1">
          {(["long", "short"] as const).map((side) => (
            <button key={side} type="button" onClick={() => set({ side })}
              className={`rounded-md py-1.5 text-sm font-medium transition-colors ${form.side === side ? (side === "long" ? "bg-up text-black" : "bg-down text-black") : "text-muted hover:text-foreground"}`}>
              {side === "long" ? "Buy (long)" : "Sell (short)"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-muted">Entry price</span>
            <input type="number" step="any" className={`${input} mt-1`} value={form.entry ?? ""} placeholder={latest ? String(latest) : "latest"}
              onChange={(e) => set({ entry: e.target.value === "" ? null : Number(e.target.value) })} />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Ounces</span>
            <input type="number" step="any" min={0.01} className={`${input} mt-1`} value={form.units}
              onChange={(e) => set({ units: Number(e.target.value) || 1 })} />
          </label>
        </div>

        {[
          { label: "Stop loss", v: stopPct, setV: setStopPct, px: stop, colour: "accent-[var(--down)]", max: 20 },
          { label: "Take profit", v: targetPct, setV: setTargetPct, px: target, colour: "accent-[var(--up)]", max: 40 },
        ].map((f) => (
          <div key={f.label} className="text-sm">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-muted">
                <input type="checkbox" checked={f.v !== null} onChange={(e) => f.setV(e.target.checked ? f.max / 10 : null)} className="accent-[var(--gold)]" />
                {f.label}
              </label>
              {f.v !== null && <span className="tabular-nums">{f.v.toFixed(1)}%{f.px ? ` · ${price(f.px)}` : ""}</span>}
            </div>
            {f.v !== null && (
              <input type="range" min={0.2} max={f.max} step={0.1} value={f.v} onChange={(e) => f.setV(Number(e.target.value))}
                className={`mt-2 w-full ${f.colour}`} />
            )}
          </div>
        ))}

        <div className="text-sm">
          <span className="text-muted">Hold for up to</span>
          <div className="mt-1 grid grid-cols-5 gap-1">
            {HORIZONS.map((hz) => (
              <button key={hz.days} type="button" onClick={() => set({ horizon_days: hz.days })}
                className={`rounded-md border px-1 py-1.5 text-xs ${form.horizon_days === hz.days ? "border-gold bg-gold/10 text-foreground" : "border-border text-muted hover:text-foreground"}`}>
                {hz.label}
              </button>
            ))}
          </div>
        </div>

        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">More settings</summary>
          <div className="mt-3 space-y-3 text-sm">
            <label className="block">
              <span className="text-muted">Account size ($)</span>
              <input type="number" min={1} className={`${input} mt-1`} value={form.capital} onChange={(e) => set({ capital: Number(e.target.value) || 10000 })} />
            </label>
            <label className="block">
              <span className="text-muted">Learn from the last {form.lookback_years} years</span>
              <input type="range" min={1} max={20} value={form.lookback_years} onChange={(e) => set({ lookback_years: Number(e.target.value) })} className="mt-2 w-full accent-[var(--gold)]" />
            </label>
            <label className="flex items-start gap-2 text-muted">
              <input type="checkbox" checked={form.with_trend} onChange={(e) => set({ with_trend: e.target.checked })} className="mt-0.5 accent-[var(--gold)]" />
              <span>Keep the past trend. Off by default: past direction is no guide to future direction, so paths are centred on today&apos;s price.</span>
            </label>
          </div>
        </details>

        {error && <p className="text-sm text-down">{error}</p>}
        <button disabled={busy || !entry} className="w-full rounded-md bg-gold py-2 font-medium text-black disabled:opacity-60">
          {busy ? "Simulating…" : "Run 2,000 scenarios"}
        </button>
      </form>

      <section className="min-w-0 space-y-5">
        <div className="rounded-lg border border-gold/30 bg-gold/5 px-4 py-3 text-xs leading-relaxed text-muted">
          <b className="text-foreground">This is not a forecast.</b> Each scenario strings together real trading days picked at random from
          gold&apos;s history, to show how far and how often the price has moved. It can&apos;t know what happens next, and it isn&apos;t advice to trade.
        </div>

        {!s ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted">
            {busy ? "Simulating…" : "Set up a trade and press Run to see its possible outcomes."}
          </div>
        ) : (
          <div className={`space-y-5 transition-opacity ${busy ? "opacity-50" : ""}`}>
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-medium">Where gold could be by {day(s.bands[s.bands.length - 1].t, true)}</h2>
                <p className="text-xs text-muted">Hover the chart for any date</p>
              </div>
              <FanChart s={s} stop={stop} target={target} />
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div className="rounded-xl border border-border bg-surface p-4">
                <h3 className="mb-3 text-sm font-medium">How the trade ended</h3>
                <OutcomeBar o={s.outcomes} />
                <p className="mt-3 text-xs text-muted">Typically closed after {Math.round(s.median_days_held)} trading day{s.median_days_held === 1 ? "" : "s"}.</p>
              </div>
              <div className="rounded-xl border border-border bg-surface p-4">
                <div className="mb-3 flex items-baseline justify-between">
                  <h3 className="text-sm font-medium">Profit or loss</h3>
                  <p className="text-xs text-muted">{s.pnl.profit_pct.toFixed(0)}% of paths in profit</p>
                </div>
                <PnlHistogram s={s} />
                <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                  <div><p className="text-muted">Bad case</p><p className="text-sm font-semibold tabular-nums text-down">{money(s.pnl.p5, true)}</p></div>
                  <div><p className="text-muted">Middle</p><p className={`text-sm font-semibold tabular-nums ${s.pnl.p50 >= 0 ? "text-up" : "text-down"}`}>{money(s.pnl.p50, true)}</p></div>
                  <div><p className="text-muted">Good case</p><p className="text-sm font-semibold tabular-nums text-up">{money(s.pnl.p95, true)}</p></div>
                </div>
                <p className="mt-2 text-[11px] text-muted">Bad and good cases are the 5th and 95th percentiles, after spread and swap.</p>
              </div>
            </div>

            {s.checkpoints.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm tabular-nums">
                  <thead className="bg-surface text-left text-xs text-muted">
                    <tr>
                      <th className="px-3 py-2">After</th>
                      <th className="px-3 py-2">9 in 10 paths between</th>
                      <th className="px-3 py-2">Middle</th>
                      <th className="px-3 py-2 text-right">Above entry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.checkpoints.map((c) => (
                      <tr key={c.label} className="border-t border-border">
                        <td className="px-3 py-2">{c.label}</td>
                        <td className="px-3 py-2">{price(c.p5)} – {price(c.p95)}</td>
                        <td className="px-3 py-2">{price(c.p50)}</td>
                        <td className="px-3 py-2 text-right">{c.above_entry_pct.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border bg-surface p-4">
                <p className="text-xs text-muted">Loss if the stop is hit</p>
                <p className={`mt-1 text-lg font-semibold tabular-nums ${riskOver ? "text-down" : ""}`}>
                  {s.loss_at_stop != null ? `${money(s.loss_at_stop)} · ${s.loss_at_stop_pct}%` : "No stop"}
                </p>
                {s.profile && <p className="text-xs text-muted">Your {s.profile.label.toLowerCase()} limit: {s.profile.max_risk_per_trade_pct}%</p>}
              </div>
              <div className="rounded-xl border border-border bg-surface p-4">
                <p className="text-xs text-muted">Position vs account</p>
                <p className={`mt-1 text-lg font-semibold tabular-nums ${levOver ? "text-down" : ""}`}>{s.leverage}x</p>
                {s.profile && <p className="text-xs text-muted">Your limit: {s.profile.max_leverage}x</p>}
              </div>
              <div className="rounded-xl border border-border bg-surface p-4">
                <p className="text-xs text-muted">Gold&apos;s yearly swings</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">±{s.history.yearly_volatility_pct}%</p>
                <p className="text-xs text-muted">from {s.history.days.toLocaleString()} trading days{s.history.from ? ` since ${day(s.history.from, true)}` : ""}</p>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
