"use client";

import { useState } from "react";
import { api, type Condition, type CustomCatalog, type Operand, type Rules, type SweepRow } from "@/lib/api";
import { Icon } from "../ui";

type Lane = "long_entry" | "long_exit" | "short_entry" | "short_exit";
type Knob = { lane: Lane; index: number; side: "left" | "right"; field: "n" | "m" | "value"; label: string; v: number; min: number; max: number; step: number };

const LANE_WORD: Record<Lane, string> = { long_entry: "Buy", long_exit: "Close buy", short_entry: "Short", short_exit: "Close short" };
// Sensible slider ranges for numbers compared with bounded indicators.
const BOUNDS: Record<string, [number, number]> = {
  rsi: [0, 100], stoch: [0, 100], adx: [0, 100], plus_di: [0, 100], minus_di: [0, 100], williams_r: [-100, 0], cci: [-300, 300], roc: [-20, 20], atr_pct: [0, 10],
};

function knobs(r: Rules, cat: CustomCatalog): Knob[] {
  const out: Knob[] = [];
  const name = (o: Operand) => cat.indicators.find((i) => i.key === o.ind);
  (Object.keys(LANE_WORD) as Lane[]).forEach((lane) => r[lane].forEach((c: Condition, index) => {
    (["left", "right"] as const).forEach((side) => {
      const o = c[side];
      const spec = name(o);
      if (o.ind === "value" && o.value != null) {
        const other = side === "right" ? c.left : c.right;
        const [lo, hi] = BOUNDS[other.ind] ?? [Math.min(o.value * 0.5, o.value * 1.5), Math.max(o.value * 0.5, o.value * 1.5) || 100];
        out.push({ lane, index, side, field: "value", label: `${name(other)?.label ?? other.ind} level`, v: o.value, min: lo, max: hi, step: hi - lo > 50 ? 1 : 0.1 });
      }
      if (spec?.n && o.n != null) out.push({ lane, index, side, field: "n", label: `${spec.label} · ${spec.n.label.toLowerCase()}`, v: o.n, min: 2, max: Math.max(250, o.n * 2), step: 1 });
      if (spec?.m && o.m != null) {
        const sd = o.ind.startsWith("bb_");
        out.push({ lane, index, side, field: "m", label: `${spec.label} · ${spec.m.label.toLowerCase()}`, v: o.m, min: sd ? 0.5 : 3, max: sd ? 4 : 120, step: sd ? 0.1 : 1 });
      }
    });
  }));
  return out;
}

function values(k: Knob): number[] {
  const n = 9, lo = k.min, hi = k.max;
  const raw = Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  const round = (x: number) => (k.step >= 1 ? Math.round(x) : Math.round(x * 10) / 10);
  return [...new Set([...raw.map(round), k.v])].filter((x) => k.field === "value" || x >= 1).sort((a, b) => a - b).slice(0, 12);
}

/** Every number in the rules as a slider, plus a range test that re-runs the strategy across a spread of values. */
export default function TunePanel({ rules, cat, test, onChange }: {
  rules: Rules; cat: CustomCatalog; test: { tf: "1d" | "1h"; years: number; stop: number | null }; onChange: (r: Rules) => void;
}) {
  const [sweep, setSweep] = useState<{ key: string; rows: SweepRow[] | null; err?: string } | null>(null);
  const list = knobs(rules, cat);
  if (!list.length) return null;
  const id = (k: Knob) => `${k.lane}.${k.index}.${k.side}.${k.field}`;

  function set(k: Knob, v: number) {
    const next = structuredClone(rules);
    (next[k.lane][k.index][k.side] as Operand)[k.field] = v;
    onChange(next);
  }

  async function range(k: Knob) {
    const key = id(k);
    if (sweep?.key === key) return setSweep(null);
    setSweep({ key, rows: null });
    try {
      const rows = await api.customSweep({ rules, tf: test.tf, years: test.years, stop_loss_pct: test.stop, lane: k.lane, index: k.index, side: k.side, field: k.field, values: values(k) });
      setSweep({ key, rows });
    } catch (e) {
      setSweep({ key, rows: [], err: e instanceof Error ? e.message : "Couldn't run the range test" });
    }
  }

  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gold/10 text-gold"><Icon name="scale" className="h-4 w-4" /></span>
        <h3 className="font-semibold">Tune it</h3>
        <span className="ml-auto text-xs text-muted">Drag a slider and the preview follows</span>
      </div>
      <ul className="mt-4 space-y-4">
        {list.map((k) => {
          const key = id(k), s = sweep?.key === key ? sweep : null;
          const ok = s?.rows?.filter((r) => r.ok && r.return_pct != null) ?? [];
          // Scale between the worst and best result so differences show, with zero marked when it's in range.
          const lo = Math.min(0, ...ok.map((r) => r.return_pct!)), hi = Math.max(0, ...ok.map((r) => r.return_pct!));
          const spanR = hi - lo || 1;
          const best = ok.reduce<SweepRow | null>((b, r) => (!b || r.return_pct! > b.return_pct! ? r : b), null);
          return (
            <li key={key}>
              <div className="flex items-center gap-2 text-sm">
                <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{LANE_WORD[k.lane]}</span>
                <span className="min-w-0 flex-1 truncate">{k.label}</span>
                <span className="w-14 text-right font-semibold tabular-nums text-gold">{k.v}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                <input type="range" min={k.min} max={k.max} step={k.step} value={k.v} aria-label={k.label}
                  onChange={(e) => set(k, Number(e.target.value))} className="h-1.5 flex-1 cursor-pointer accent-[var(--gold)]" />
                <button type="button" onClick={() => range(k)} aria-expanded={!!s}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors ${s ? "border-gold text-gold" : "border-border text-muted hover:text-foreground"}`}>
                  Range test
                </button>
              </div>
              {s && (
                <div className="fan-in mt-3 rounded-xl border border-border bg-background/60 p-3">
                  {!s.rows ? <div className="h-24 animate-pulse rounded-lg bg-surface-2" /> : s.err ? <p className="text-sm text-down">{s.err}</p> : (
                    <>
                      <div className="flex h-28 items-end gap-1">
                        {s.rows.map((r) => {
                          const v = r.return_pct ?? 0, h = r.ok ? Math.max(((v - lo) / spanR) * 100, 4) : 4;
                          const cur = r.value === k.v;
                          return (
                            <button key={r.value} type="button" disabled={!r.ok} onClick={() => set(k, r.value)}
                              title={r.ok ? `${r.value}: ${v >= 0 ? "+" : ""}${v.toFixed(1)}%, ${r.trades} trades, worst drop ${r.max_drawdown_pct?.toFixed(1)}%` : `${r.value}: not valid`}
                              className="group flex h-full min-w-0 flex-1 flex-col justify-end">
                              {r.ok && <span className="mb-0.5 truncate text-center text-[9px] tabular-nums text-muted group-hover:text-foreground">{v >= 0 ? "+" : ""}{v.toFixed(0)}%</span>}
                              <span className={`bar-rise block w-full rounded-t-md transition ${!r.ok ? "bg-border" : v >= 0 ? "bg-up/70 group-hover:bg-up" : "bg-down/70 group-hover:bg-down"} ${cur ? "ring-2 ring-gold ring-offset-1 ring-offset-background" : ""}`}
                                style={{ height: `${h}%` }} />
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-1 flex gap-1 text-center text-[10px] tabular-nums text-muted">
                        {s.rows.map((r) => <span key={r.value} className="flex-1 truncate">{r.value}</span>)}
                      </div>
                      <p className="mt-2 text-xs text-muted">
                        Tap a bar to use that value.{best && <> The best past return was at <b className="text-foreground">{best.value}</b>, </>}
                        but a setting that only works at one exact value is usually luck. Look for a broad plateau.
                      </p>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
