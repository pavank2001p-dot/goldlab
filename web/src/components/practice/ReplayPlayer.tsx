"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { fmtPrice, fmtUsd, type ReplayBar, type ReplaySettled, type ReplayTradeIn } from "@/lib/api";
import { hits, settle } from "@/lib/replay";
import { useThemeKey } from "@/lib/theme";
import { toast } from "../Toaster";
import { Icon } from "../ui";

const SPEEDS = [1, 2, 4, 8, 16];
const TF_NAME: Record<string, string> = { "1h": "Hourly", "4h": "4-hour", "1d": "Daily" };
const field = "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-gold";

type Open = Omit<ReplayTradeIn, "exit_bar">;
/** Everything needed to resume a session where it was left. */
export type PlayerState = { k: number; done: ReplaySettled[]; pos: Open | null; units: string; stopDist: string; targetDist: string };
export type Higher = { tf: string; seconds: number; context: ReplayBar[] };

/** Higher-timeframe candles built from the base candles shown so far; the last one is still forming. */
function aggregate(bars: ReplayBar[], seconds: number): ReplayBar[] {
  const out: ReplayBar[] = [];
  for (const b of bars) {
    const t = b.t - (b.t % seconds);
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}

function chartOptions(blind: boolean) {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    v,
    opts: {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: v("--muted"), attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: v("--border") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, rightOffset: 8, ...(blind ? { tickMarkFormatter: () => "" } : {}) },
      localization: { locale: "en-US", ...(blind ? { timeFormatter: () => "" } : {}) },
    },
  };
}

/** The higher timeframe beside the replay, revealed in step with it. */
function HigherChart({ higher, shown, blind, label }: { higher: Higher; shown: ReplayBar[]; blind: boolean; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const themeKey = useThemeKey();
  useEffect(() => {
    const { v, opts } = chartOptions(blind);
    const chart = createChart(box.current!, opts);
    ref.current = chart.addSeries(CandlestickSeries, {
      upColor: v("--up"), downColor: v("--down"), borderVisible: false, wickUpColor: v("--up"), wickDownColor: v("--down"), priceLineColor: v("--gold"),
    });
    chartRef.current = chart;
    return () => { chart.remove(); ref.current = null; chartRef.current = null; };
  }, [themeKey, blind]);
  const data = useMemo(() => {
    const own = aggregate(shown, higher.seconds);
    const first = own[0]?.t ?? Infinity;
    return [...higher.context.filter((b) => b.t < first), ...own];
  }, [shown, higher]);
  useEffect(() => {
    ref.current?.setData(data.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })));
    chartRef.current?.timeScale().scrollToRealTime();
  }, [data, themeKey, blind]);
  return (
    <div className="flex h-full flex-col">
      <p className="border-b border-border px-3 py-1.5 text-xs text-muted">{label} · the last candle is still forming</p>
      <div ref={box} className="min-h-0 flex-1" />
    </div>
  );
}

/** Reveals past candles one at a time and lets the user trade them with virtual money.
 *  With riskPct set (the challenge), every trade needs a stop that risks no more than that share of the balance. */
export default function ReplayPlayer({ bars, context, balance, leverage, riskPct, onFinish, height = 420, blind = false, higher, initial, onState }: {
  bars: ReplayBar[]; context: ReplayBar[]; balance: number; leverage: number; riskPct?: number;
  onFinish: (trades: ReplayTradeIn[], done: ReplaySettled[]) => void; height?: number;
  /** Hide dates and times until the replay ends, so memory of what happened can't steer the trades. */
  blind?: boolean;
  /** A higher timeframe shown beside the replay, built from the same candles as they appear. */
  higher?: Higher;
  /** Where a saved session was left, and a callback with the state whenever it changes. */
  initial?: Partial<PlayerState>;
  onState?: (s: PlayerState) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ chart: IChartApi; series: ISeriesApi<"Candlestick">; markers: ISeriesMarkersPluginApi<Time> } | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const themeKey = useThemeKey();
  const [k, setK] = useState(Math.min(Math.max(initial?.k ?? 1, 1), bars.length)); // bars revealed
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [pos, setPos] = useState<Open | null>(initial?.pos ?? null);
  const [done, setDone] = useState<ReplaySettled[]>(initial?.done ?? []);
  const [finished, setFinished] = useState(false);
  const [units, setUnits] = useState(initial?.units ?? "10");
  const [stopDist, setStopDist] = useState(initial?.stopDist ?? (riskPct ? "5" : ""));
  const [targetDist, setTargetDist] = useState(initial?.targetDist ?? "");
  const hide = blind && !finished;
  useEffect(() => {
    if (!finished) onState?.({ k, done, pos, units, stopDist, targetDist });
  }, [k, done, pos, units, stopDist, targetDist, finished, onState]);
  const [riskInput, setRiskInput] = useState(String(Math.min(riskPct ?? 1, 1)));
  const [error, setError] = useState<string | null>(null);

  const i = k - 1; // index of the bar on screen
  const price = bars[i].c;
  const cash = balance + done.reduce((s, t) => s + t.pnl, 0);
  const openPnl = pos ? (price - bars[pos.entry_bar].c) * pos.units * (pos.side === "long" ? 1 : -1) : 0;
  const equity = cash + openPnl;
  const wins = done.filter((t) => t.pnl > 0).length;

  // Chart, rebuilt with the theme (and when a blind replay ends, to show its dates).
  useEffect(() => {
    const el = box.current!;
    const { v, opts } = chartOptions(hide);
    const chart = createChart(el, opts);
    const series = chart.addSeries(CandlestickSeries, {
      upColor: v("--up"), downColor: v("--down"), borderVisible: false, wickUpColor: v("--up"), wickDownColor: v("--down"),
      priceLineColor: v("--gold"),
    });
    chartRef.current = { chart, series, markers: createSeriesMarkers(series, []) };
    return () => { chart.remove(); chartRef.current = null; lines.current = []; };
  }, [themeKey, hide]);

  // Candles, markers and the open trade's lines.
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const shown = [...context, ...bars.slice(0, k)];
    c.series.setData(shown.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })));
    const marks: SeriesMarker<Time>[] = [];
    for (const t of done) {
      marks.push({ time: bars[t.entry_bar].t as UTCTimestamp, position: t.side === "long" ? "belowBar" : "aboveBar",
        shape: t.side === "long" ? "arrowUp" : "arrowDown", color: t.side === "long" ? v("--up") : v("--down") });
      marks.push({ time: bars[t.exit_bar].t as UTCTimestamp, position: t.side === "long" ? "aboveBar" : "belowBar", shape: "circle",
        color: t.pnl >= 0 ? v("--gold") : v("--muted"), text: `${t.pnl >= 0 ? "+" : ""}${Math.round(t.pnl)}` });
    }
    if (pos) marks.push({ time: bars[pos.entry_bar].t as UTCTimestamp, position: pos.side === "long" ? "belowBar" : "aboveBar",
      shape: pos.side === "long" ? "arrowUp" : "arrowDown", color: pos.side === "long" ? v("--up") : v("--down"), text: pos.side === "long" ? "Buy" : "Sell" });
    marks.sort((a, b) => (a.time as number) - (b.time as number));
    c.markers.setMarkers(marks);
    for (const l of lines.current) c.series.removePriceLine(l);
    lines.current = [];
    if (pos) {
      const add = (p: number, color: string, title: string, style = LineStyle.Dashed) =>
        lines.current.push(c.series.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
      add(bars[pos.entry_bar].c, v("--muted"), "Entry", LineStyle.Dotted);
      if (pos.stop != null) add(pos.stop, v("--down"), "Stop");
      if (pos.target != null) add(pos.target, v("--up"), "Target");
    }
    if (k <= 2 || finished) c.chart.timeScale().fitContent();
    else c.chart.timeScale().scrollToRealTime();
  }, [k, done, pos, bars, context, themeKey, finished, hide]);

  // Ends the replay, closing any open trade at the close of the bar given.
  const finish = useCallback((openTrade: Open | null, closed: ReplaySettled[], at: number) => {
    setPlaying(false);
    let all = closed;
    if (openTrade) all = [...closed, settle(bars, { ...openTrade, exit_bar: Math.max(at, openTrade.entry_bar) })];
    setPos(null);
    setDone(all);
    setFinished(true);
    setK(bars.length); // show the rest, so they can see what happened after

    onFinish(all.map(({ side, units, entry_bar, exit_bar, stop, target }) => ({ side, units, entry_bar, exit_bar, stop, target })), all);
  }, [bars, onFinish]);

  // Reveal the next bar, closing the open trade if the bar reaches its stop or target.
  const step = useCallback(() => {
    if (finished) return;
    if (k >= bars.length) { finish(pos, done, bars.length - 1); return; }
    const j = k;
    let closed = done, open = pos;
    if (pos && hits(bars[j], pos)) {
      const s = settle(bars, { ...pos, exit_bar: j });
      closed = [...done, s];
      open = null;
      setDone(closed);
      setPos(null);
      toast(s.reason === "stop" ? "Stopped out" : "Target reached", { body: `${s.pnl >= 0 ? "+" : ""}${fmtUsd(s.pnl)} at ${fmtPrice(s.exit_price)}`, tone: s.pnl >= 0 ? "up" : "down" });
    }
    setK(j + 1);
    if (j + 1 >= bars.length) finish(open, closed, j);
  }, [k, bars, pos, done, finished, finish]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(step, 1000 / speed);
    return () => clearInterval(t);
  }, [playing, speed, step]);

  const stop = stopDist.trim() ? Number(stopDist) : null;
  const target = targetDist.trim() ? Number(targetDist) : null;
  const oz = Number(units);
  const risk = stop ? stop * oz : null;
  const tooRisky = riskPct != null && (risk == null || risk > (cash * riskPct) / 100 + 0.01);
  const sizeFor = useMemo(() => {
    const r = Number(riskInput);
    if (!stop || !(r > 0)) return null;
    const byRisk = (cash * r) / 100 / stop;
    const byMargin = (cash * leverage) / price;
    return Math.floor(Math.min(byRisk, byMargin) * 100) / 100;
  }, [riskInput, stop, cash, leverage, price]);

  function open(side: "long" | "short") {
    setError(null);
    if (pos || finished) return;
    if (!(oz > 0)) return setError("Enter a size in ounces.");
    if (oz * price > cash * leverage + 0.01) return setError(`That's more than 1:${leverage} leverage allows. Most you can open is ${Math.floor((cash * leverage / price) * 100) / 100} oz.`);
    if (stop != null && !(stop > 0)) return setError("A stop distance is a positive number of dollars.");
    if (riskPct != null && stop == null) return setError("Every challenge trade needs a stop.");
    if (riskPct != null && tooRisky) return setError(`That risks ${fmtUsd(risk)}, more than ${riskPct}% of your balance. Use a smaller size or a closer stop.`);
    const dir = side === "long" ? 1 : -1;
    setPos({ side, units: oz, entry_bar: i, stop: stop != null ? Math.round((price - dir * stop) * 100) / 100 : null,
      target: target ? Math.round((price + dir * target) * 100) / 100 : null });
    toast(side === "long" ? "Bought" : "Sold", { body: `${oz} oz at ${fmtPrice(price)}`, tone: "fill" });
  }

  function close() {
    if (!pos) return;
    const s = settle(bars, { ...pos, exit_bar: i });
    setDone([...done, s]);
    setPos(null);
    toast("Closed", { body: `${s.pnl >= 0 ? "+" : ""}${fmtUsd(s.pnl)}`, tone: s.pnl >= 0 ? "up" : "down" });
  }

  // Keyboard: space plays, right arrow steps, B buys, S sells, C closes.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); step(); }
      else if (e.key === "b" || e.key === "B") open("long");
      else if (e.key === "s" || e.key === "S") open("short");
      else if (e.key === "c" || e.key === "C") close();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const pct = (k / bars.length) * 100;
  const when = hide ? "Dates hidden" : new Date(bars[i].t * 1000).toLocaleString("en-GB", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", ...(higher ? { day: "numeric", month: "short", year: "numeric" } : {}) }) + " UTC";
  const shownBars = useMemo(() => bars.slice(0, k), [bars, k]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="card overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <button type="button" onClick={() => setPlaying(!playing)} disabled={finished} aria-label={playing ? "Pause" : "Play"}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-b from-gold-hi to-gold text-black disabled:opacity-40">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>{playing ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}</svg>
          </button>
          <button type="button" onClick={() => { setPlaying(false); step(); }} disabled={finished} title="Next candle (→)"
            className="rounded-full border border-border px-3 py-1 text-xs disabled:opacity-40 hover:border-gold/50">Next candle</button>
          <div className="flex rounded-full border border-border p-0.5 text-xs" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" onClick={() => setSpeed(s)} aria-pressed={speed === s}
                className={`rounded-full px-2 py-0.5 tabular-nums ${speed === s ? "bg-gold text-black" : "text-muted hover:text-foreground"}`}>{s}×</button>
            ))}
          </div>
          <span className="ml-auto text-xs tabular-nums text-muted">{when} · candle {k} of {bars.length}</span>
        </div>
        <div className="h-1 bg-border/60"><div className="h-full bg-gold transition-[width] duration-200" style={{ width: `${pct}%` }} /></div>
        {higher ? (
          <div style={{ "--h": `${height}px` } as React.CSSProperties} className="grid lg:h-[var(--h)] lg:grid-cols-[3fr_2fr]">
            <div ref={box} className="h-[300px] w-full lg:h-full" />
            <div className="h-[220px] border-t border-border lg:h-full lg:border-l lg:border-t-0">
              <HigherChart higher={higher} shown={shownBars} blind={hide} label={`${TF_NAME[higher.tf] ?? higher.tf} candles`} />
            </div>
          </div>
        ) : (
          <div ref={box} style={{ "--h": `${height}px` } as React.CSSProperties} className="h-[300px] w-full lg:h-[var(--h)]" />
        )}
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
          Keys: space plays or pauses, → shows the next candle, B buys, S sells, C closes. Fills are at the candle close, with no spread.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="card p-4">
          <p className="text-xs text-muted">Equity</p>
          <p className="text-2xl font-bold tabular-nums">{fmtUsd(equity)}</p>
          <p className={`text-sm tabular-nums ${equity >= balance ? "text-up" : "text-down"}`}>
            {equity >= balance ? "+" : ""}{((equity / balance - 1) * 100).toFixed(2)}% · {done.length} trade{done.length === 1 ? "" : "s"}{done.length ? `, ${wins} won` : ""}
          </p>
          {pos && (
            <div className="mt-3 rounded-xl bg-background/50 p-2.5 text-xs">
              <p className="flex justify-between"><span className="font-medium">{pos.side === "long" ? "Long" : "Short"} {pos.units} oz</span>
                <span className={`tabular-nums ${openPnl >= 0 ? "text-up" : "text-down"}`}>{openPnl >= 0 ? "+" : ""}{fmtUsd(openPnl)}</span></p>
              <p className="mt-1 text-muted tabular-nums">Entry {fmtPrice(bars[pos.entry_bar].c)}{pos.stop != null ? ` · stop ${fmtPrice(pos.stop)}` : ""}{pos.target != null ? ` · target ${fmtPrice(pos.target)}` : ""}</p>
            </div>
          )}
        </div>

        <div className="card space-y-3 p-4 max-lg:order-first">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <label><span className="text-muted">Ounces</span><input inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} className={`mt-1 ${field}`} /></label>
            <label><span className="text-muted">Stop, $ away{riskPct ? "" : " (opt.)"}</span><input inputMode="decimal" value={stopDist} onChange={(e) => setStopDist(e.target.value)} placeholder="none" className={`mt-1 ${field}`} /></label>
            <label><span className="text-muted">Target, $ away</span><input inputMode="decimal" value={targetDist} onChange={(e) => setTargetDist(e.target.value)} placeholder="none" className={`mt-1 ${field}`} /></label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            Size for
            <input inputMode="decimal" value={riskInput} onChange={(e) => setRiskInput(e.target.value)} aria-label="Risk percent" className="w-12 rounded-md border border-border bg-background px-1.5 py-0.5 text-center tabular-nums outline-none focus:border-gold" />
            % risk
            <button type="button" disabled={sizeFor == null || sizeFor <= 0} onClick={() => sizeFor && setUnits(String(sizeFor))}
              className="rounded-full border border-border px-2 py-0.5 text-foreground disabled:opacity-40 hover:border-gold/50">
              {sizeFor != null ? `Use ${sizeFor} oz` : "Set a stop first"}
            </button>
          </div>
          {risk != null && (
            <p className={`text-xs tabular-nums ${tooRisky ? "text-down" : "text-muted"}`}>
              If the stop is hit you lose {fmtUsd(risk)} ({((risk / cash) * 100).toFixed(2)}% of your balance){riskPct ? `. Limit ${riskPct}%.` : "."}
            </p>
          )}
          {error && <p role="alert" className="text-xs text-down">{error}</p>}
          {pos ? (
            <button type="button" onClick={close} disabled={finished} className="w-full rounded-full border border-border py-2 text-sm font-semibold hover:border-gold/50">
              Close at {fmtPrice(price)}
            </button>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => open("long")} disabled={finished} className="rounded-full bg-up py-2 text-sm font-semibold text-black disabled:opacity-40">Buy {fmtPrice(price)}</button>
              <button type="button" onClick={() => open("short")} disabled={finished} className="rounded-full bg-down py-2 text-sm font-semibold text-black disabled:opacity-40">Sell {fmtPrice(price)}</button>
            </div>
          )}
          {!finished && (
            <button type="button" onClick={() => finish(pos, done, i)} className="flex w-full items-center justify-center gap-1 text-xs text-muted hover:text-foreground">
              Finish now <Icon name="arrow" className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
