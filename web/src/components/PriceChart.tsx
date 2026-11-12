"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { useThemeKey } from "@/lib/theme";
import Drawings from "./chart/Drawings";
import { IND_LIST, ema, macd, pts, rsi, sma, stdev, type IndKey } from "./chart/indicators";
import { api, type Bar, type ChartMarker, type ChartTf, type LiveQuote, type Market } from "@/lib/api";
import { usePref } from "@/lib/prefs";
import { GOLD, fmtMarketPrice, ticker } from "@/lib/markets";

const GROUPS: { label: string; tfs: [ChartTf, string][] }[] = [
  { label: "Seconds", tfs: [["1s", "1s"], ["5s", "5s"], ["15s", "15s"], ["30s", "30s"]] },
  { label: "Minutes", tfs: [["1m", "1m"], ["5m", "5m"], ["15m", "15m"], ["30m", "30m"]] },
  { label: "Hours", tfs: [["1h", "1H"], ["4h", "4H"]] },
  { label: "Days", tfs: [["1d", "1D"], ["1w", "1W"], ["1mo", "1M"]] },
];

// Bar length in seconds for timeframes on fixed UTC slots; days, weeks and months follow the calendar.
const SIZE: Partial<Record<ChartTf, number>> = {
  "1s": 1, "5s": 5, "15s": 15, "30s": 30, "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400,
};
const PAGE = 2000;
const ALL_MONTHS = 5000; // the whole monthly history (since 1833) in one request
const VISIBLE = 150; // bars shown when a timeframe opens
const isSeconds = (tf: ChartTf) => tf.endsWith("s");

// Some browsers report locales Intl rejects (e.g. "en-US@posix"); fall back to en-US.
function safeLocale() {
  try {
    return Intl.NumberFormat.supportedLocalesOf([navigator.language])[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

const toCandle = (b: Bar): CandlestickData => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c });

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const IND_KEY = "goldlab-indicators";
const NO_INDS: IndKey[] = [];
export const EVENT_COLOR: Record<ChartMarker["kind"], string> = {
  fed: "#e8b53e", inflation: "#f97316", jobs: "#60a5fa", growth: "#a78bfa", dollar: "#2dd4bf", shock: "#f43f5e", other: "#94a3b8",
};
const EVENT_LETTER: Record<ChartMarker["kind"], string> = { fed: "F", inflation: "CPI", jobs: "J", growth: "G", dollar: "$", shock: "!", other: "•" };
const EVENT_NAME: Record<ChartMarker["kind"], string> = {
  fed: "Fed", inflation: "Inflation", jobs: "Jobs", growth: "Growth", dollar: "Dollar", shock: "Shock", other: "Release",
};

/** `below` is a strip under the candles (inside the chart's frame, so it stays in full screen) for overlay controls. */
export type ChartOverlay = (c: { chart: IChartApi; series: ISeriesApi<"Candlestick">; below: HTMLDivElement | null }) => React.ReactNode;

export default function PriceChart({ height = 520, initialTf = "1h", tools = false, overlay, market = GOLD, picker }: {
  height?: number; initialTf?: ChartTf; tools?: boolean;
  /** Extra layers drawn over the candles, such as paper orders and positions. */
  overlay?: ChartOverlay;
  /** The market to show (gold by default). */
  market?: Market;
  /** Shown in place of the market's name in the toolbar, such as a market picker. */
  picker?: React.ReactNode;
}) {
  const symbol = market.symbol;
  const fmtPrice = (p: number) => fmtMarketPrice(p, market);
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [tf, setTf] = useState<ChartTf>(initialTf);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [full, setFull] = useState(false);
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [all, setAll] = useState(false); // whole history on monthly candles
  const [logScale, setLogScale] = useState(false);
  const [loading, setLoading] = useState(true);
  const themeKey = useThemeKey();
  // For drawings and indicators: the bars on the chart, and a counter that changes when they are reloaded.
  const barsRef = useRef<Bar[]>([]);
  const [ver, setVer] = useState(0);
  const [ready, setReady] = useState<{ chart: IChartApi; series: ISeriesApi<"Candlestick"> } | null>(null);
  const [inds, setInds] = usePref<IndKey[]>("indicators", IND_KEY, NO_INDS, tools);
  const [showEvents, setShowEvents] = usePref<boolean>("chart_events", "goldlab-chart-events", true, tools);
  const [events, setEvents] = useState<ChartMarker[]>([]);
  const [hoverEvents, setHoverEvents] = useState<ChartMarker[]>([]);
  const eventsByBar = useRef(new Map<number, ChartMarker[]>());
  const eventsKey = useRef("");
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [indOpen, setIndOpen] = useState(false);
  const [below, setBelow] = useState<HTMLDivElement | null>(null);
  const [legend, setLegend] = useState<Bar | null>(null);
  const [accent, setAccent] = useState("#e8b53e");
  useEffect(() => {
    setAccent(getComputedStyle(document.documentElement).getPropertyValue("--gold").trim() || "#e8b53e");
  }, [themeKey]);
  const toggleInd = (k: IndKey) => setInds(inds.includes(k) ? inds.filter((x) => x !== k) : [...inds, k]);

  // Create the chart once.
  useEffect(() => {
    const el = box.current!;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: v("--surface") }, textColor: v("--muted"), attributionLogo: false },
      grid: { vertLines: { color: v("--border") }, horzLines: { color: v("--border") } },
      rightPriceScale: { borderColor: v("--border") },
      timeScale: { borderColor: v("--border"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { locale: safeLocale() },
    });
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: v("--up"),
      downColor: v("--down"),
      borderVisible: false,
      wickUpColor: v("--up"),
      wickDownColor: v("--down"),
      priceFormat: { type: "price", precision: market.decimals, minMove: 10 ** -market.decimals },
    });
    chartRef.current = chart;
    setReady({ chart, series: seriesRef.current });
    return () => {
      setReady(null);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // Built once; the precision effect below follows the market after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Price decimals follow the market (5 for EUR/USD, 2 for gold).
  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: { type: "price", precision: market.decimals, minMove: 10 ** -market.decimals } });
  }, [market.decimals]);

  // Markets without second bars or long history fall back to a timeframe they have.
  useEffect(() => {
    if (!market.has_seconds && isSeconds(tf)) setTf("1m");
    if (!market.has_history && all) setAll(false);
  }, [market.has_seconds, market.has_history, tf, all]);

  // Recolour when the theme or accent changes.
  useEffect(() => {
    const chart = chartRef.current, series = seriesRef.current;
    if (!chart || !series || !themeKey) return;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: v("--surface") }, textColor: v("--muted") },
      grid: { vertLines: { color: v("--border") }, horzLines: { color: v("--border") } },
      rightPriceScale: { borderColor: v("--border") },
      timeScale: { borderColor: v("--border") },
    });
    series.applyOptions({ upColor: v("--up"), downColor: v("--down"), wickUpColor: v("--up"), wickDownColor: v("--down") });
  }, [themeKey]);

  // Load the selected timeframe, page in older bars on scroll, follow live quotes.
  useEffect(() => {
    const chart = chartRef.current!;
    const series = seriesRef.current!;
    let bars: Bar[] = [];
    let loadingOlder = false;
    let reachedStart = false;
    let cancelled = false;
    setError(null);
    setEmpty(false);
    setLoading(true);
    setQuote(null);
    chart.applyOptions({ timeScale: { secondsVisible: isSeconds(tf) } });

    api.candles(tf, { limit: tf === "1mo" ? ALL_MONTHS : PAGE, symbol }).then(
      (data) => {
        if (cancelled) return;
        bars = data;
        barsRef.current = bars;
        setVer((v) => v + 1);
        setLoading(false);
        setEmpty(!data.length);
        series.setData(bars.map(toCandle));
        if (all) chart.timeScale().fitContent();
        else chart.timeScale().setVisibleLogicalRange({ from: bars.length - VISIBLE, to: bars.length + 5 });
      },
      (e) => {
        if (cancelled) return;
        setLoading(false);
        setError(e.message);
      },
    );

    const onRange = async (range: { from: number } | null) => {
      if (!range || range.from > 50 || loadingOlder || reachedStart || !bars.length) return;
      loadingOlder = true;
      try {
        const older = await api.candles(tf, { end: bars[0].t, limit: PAGE, symbol });
        if (cancelled) return;
        if (!older.length) reachedStart = true;
        else {
          bars = [...older, ...bars];
          barsRef.current = bars;
          series.setData(bars.map(toCandle));
          setVer((v) => v + 1);
        }
      } finally {
        loadingOlder = false;
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    // Saved bars catch up now and then; live quotes move the newest candle in between.
    const refresh = setInterval(async () => {
      if (!bars.length) return;
      try {
        const fresh = await api.candles(tf, { start: bars[bars.length - 1].t, limit: 500, symbol });
        if (cancelled) return;
        for (const b of fresh) {
          if (b.t < bars[bars.length - 1].t) continue;
          series.update(toCandle(b));
          if (b.t === bars[bars.length - 1].t) bars[bars.length - 1] = b;
          else bars.push(b);
        }
        if (fresh.length) setVer((v) => v + 1);
      } catch {}
    }, isSeconds(tf) ? 15_000 : 60_000);

    const poll = setInterval(async () => {
      try {
        const q = await api.live(symbol);
        if (cancelled) return;
        setQuote(q);
        if (q.price == null || q.t == null || !bars.length || (q.age_seconds ?? 99) > 120) return;
        const last = bars[bars.length - 1];
        const size = SIZE[tf];
        const slot = size ? Math.floor(q.t / size) * size : last.t;
        if (slot < last.t) return;
        if (slot === last.t) {
          last.h = Math.max(last.h, q.price);
          last.l = Math.min(last.l, q.price);
          last.c = q.price;
        } else {
          bars.push({ t: slot, o: last.c, h: Math.max(last.c, q.price), l: Math.min(last.c, q.price), c: q.price, v: 0 });
        }
        series.update(toCandle(bars[bars.length - 1]));
      } catch {}
    }, isSeconds(tf) ? 1000 : 2000);

    return () => {
      cancelled = true;
      clearInterval(refresh);
      clearInterval(poll);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
    };
  }, [tf, all, symbol]);

  // Legend: the candle under the crosshair (or the latest), like other charting platforms.
  useEffect(() => {
    if (!ready) return;
    const on = (e: { time?: unknown }) => {
      const bs = barsRef.current;
      if (e.time == null) { setHoverEvents([]); return setLegend(bs[bs.length - 1] ?? null); }
      setLegend(bs.find((b) => b.t === e.time) ?? null);
      setHoverEvents(eventsByBar.current.get(e.time as number) ?? []);
    };
    ready.chart.subscribeCrosshairMove(on);
    return () => ready.chart.unsubscribeCrosshairMove(on);
  }, [ready]);
  useEffect(() => setLegend(barsRef.current[barsRef.current.length - 1] ?? null), [ver]);

  // Market events: Fed decisions, inflation and jobs releases, and turning points, marked above their candle.
  useEffect(() => {
    if (!tools || !showEvents) { setEvents([]); eventsKey.current = ""; return; }
    const bs = barsRef.current;
    if (!bs.length) return;
    const key = `${symbol}:${tf}:${all}:${bs[0].t}`;
    if (eventsKey.current === key) return;
    eventsKey.current = key;
    // Weekly and monthly candles are too coarse for every release, so show only the turning points there.
    const coarse = tf === "1w" || tf === "1mo";
    api.markers(bs[0].t, Math.floor(Date.now() / 1000) + 86400, !coarse).then(setEvents, () => setEvents([]));
  }, [tools, showEvents, tf, all, ver, symbol]);

  useEffect(() => {
    if (!ready) return;
    markers.current = createSeriesMarkers(ready.series, []);
    return () => { markers.current?.detach(); markers.current = null; };
  }, [ready]);

  useEffect(() => {
    const bs = barsRef.current, m = markers.current;
    const map = new Map<number, ChartMarker[]>();
    if (m && bs.length && events.length) {
      const last = bs[bs.length - 1].t;
      for (const e of events) {
        if (e.t < bs[0].t || e.t > last + (SIZE[tf] ?? 86400 * 31)) continue;
        let lo = 0, hi = bs.length - 1; // the last bar starting at or before the event
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bs[mid].t <= e.t) lo = mid; else hi = mid - 1; }
        const t = bs[lo].t;
        map.set(t, [...(map.get(t) ?? []), e]);
      }
    }
    eventsByBar.current = map;
    const list: SeriesMarker<Time>[] = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, es]) => {
      const top = es.find((e) => e.history) ?? es.find((e) => e.kind === "fed") ?? es[0];
      return { time: t as UTCTimestamp, position: "aboveBar", shape: "circle", size: 0.7, color: EVENT_COLOR[top.kind],
        text: es.length > 1 ? `${EVENT_LETTER[top.kind]}+${es.length - 1}` : EVENT_LETTER[top.kind] };
    });
    m?.setMarkers(list);
  }, [events, ver, tf, ready]);

  // Indicators: lines over the candles, and RSI or MACD in their own panes underneath.
  useEffect(() => {
    if (!ready || !inds.length) return;
    const { chart } = ready;
    const bs = barsRef.current;
    if (bs.length < 2) return;
    const closes = bs.map((b) => b.c);
    const added: ISeriesApi<SeriesType>[] = [];
    const line = (data: { time: number; value: number }[], color: string, pane = 0, width: 1 | 2 = 2, dashed = false) => {
      const sr = chart.addSeries(LineSeries, { color, lineWidth: width, lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false, lastValueVisible: pane > 0, crosshairMarkerVisible: false }, pane);
      sr.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
      added.push(sr);
      return sr;
    };
    let pane = 1;
    for (const k of inds) {
      const spec = IND_LIST.find((i) => i.key === k)!;
      if (k === "sma20" || k === "sma50" || k === "sma200") line(pts(bs, sma(closes, Number(k.slice(3)))), spec.color);
      else if (k === "ema21") line(pts(bs, ema(closes, 21)), spec.color);
      else if (k === "bb") {
        const m = sma(closes, 20), sd = stdev(closes, 20);
        line(pts(bs, m), spec.color, 0, 1, true);
        line(pts(bs, m.map((v, i) => (v == null ? null : v + 2 * sd[i]!))), spec.color, 0, 1);
        line(pts(bs, m.map((v, i) => (v == null ? null : v - 2 * sd[i]!))), spec.color, 0, 1);
      } else if (k === "rsi") {
        const sr = line(pts(bs, rsi(closes, 14)), spec.color, pane, 2);
        sr.createPriceLine({ price: 70, color: "#ef5a55", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
        sr.createPriceLine({ price: 30, color: "#26b89a", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
        pane++;
      } else if (k === "macd") {
        const m = macd(closes);
        const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
        hist.setData(pts(bs, m.hist).map((d) => ({ time: d.time as UTCTimestamp, value: d.value, color: d.value >= 0 ? "rgba(38,184,154,0.5)" : "rgba(239,90,85,0.5)" })));
        added.push(hist);
        line(pts(bs, m.line), spec.color, pane, 2);
        line(pts(bs, m.signal), "#e8b53e", pane, 1);
        pane++;
      }
    }
    const panes = chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(Math.round(height * 0.22));
    return () => {
      for (const sr of added) { try { chart.removeSeries(sr); } catch {} }
      for (let i = chart.panes().length - 1; i > 0; i--) { try { chart.removePane(i); } catch {} }
    };
  }, [ready, inds, ver, height, themeKey]);

  // Full screen: the browser's own where it exists (desktop, Android), otherwise fill the window (iPhone).
  const toggleFull = useCallback(async () => {
    const el = wrap.current!;
    if (full) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setFull(false);
      return;
    }
    setFull(true);
    if (el.requestFullscreen) await el.requestFullscreen().catch(() => {});
  }, [full]);

  useEffect(() => {
    const onChange = () => !document.fullscreenElement && setFull(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    document.body.style.overflow = full ? "hidden" : "";
  }, [full]);

  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [logScale]);

  const pick = (t: ChartTf) => {
    setAll(false);
    setTf(t);
  };
  const showAll = () => {
    setAll(true);
    setLogScale(true); // from $19 to $4,000+, a log scale keeps early moves readable
    if (tf === "1mo") chartRef.current?.timeScale().fitContent();
    setTf("1mo");
  };

  function zoom(factor: number) {
    const ts = chartRef.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const width = Math.max(10, (r.to - r.from) * factor);
    ts.setVisibleLogicalRange({ from: r.to - width, to: r.to }); // keep the latest bars in view
  }

  const reset = () => {
    const ts = chartRef.current?.timeScale();
    const n = seriesRef.current?.data().length ?? 0;
    ts?.setVisibleLogicalRange({ from: n - VISIBLE, to: n + 5 });
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  };

  const live = quote?.configured && quote.price != null && (quote.age_seconds ?? 999) < 60;
  const btn = "rounded p-1.5 text-muted hover:bg-background hover:text-foreground";

  return (
    <div
      ref={wrap}
      // Charts read left to right (time runs that way) whatever the page language.
      dir="ltr"
      className={`flex flex-col overflow-hidden border border-border bg-surface ${full ? "fixed inset-0 z-50" : "rounded-lg"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2 text-sm">
        {picker ?? <span className="font-medium">{ticker(market)}</span>}
        {quote?.configured && (
          <span className="flex items-center gap-1.5 text-xs">
            <span className={`h-2 w-2 rounded-full ${live ? "breathe bg-up" : "bg-muted"}`} />
            {live ? (
              <span className="tabular-nums">Live ${fmtPrice(quote!.price!)}</span>
            ) : (
              <span className="text-muted">{quote.connected ? "Market closed" : "Live feed offline"}</span>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {tools && (
            <div className="relative">
              <button onClick={() => setIndOpen(!indOpen)} aria-expanded={indOpen}
                className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${inds.length ? "text-gold" : "text-muted"} hover:bg-background hover:text-foreground`}>
                <Icon d="M3 17l5-6 4 3 5-7 4 4" /> Indicators{inds.length ? ` · ${inds.length}` : ""}
              </button>
              {indOpen && (
                <div className="rise-in absolute left-0 top-full z-20 mt-1 w-60 sm:left-auto sm:right-0 rounded-xl border border-border bg-surface p-1.5 shadow-2xl">
                  {IND_LIST.map((i) => (
                    <label key={i.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                      <input type="checkbox" checked={inds.includes(i.key)} onChange={() => toggleInd(i.key)} className="accent-[var(--gold)]" />
                      <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />
                      <span className="flex-1">{i.label}</span>
                      {i.pane && <span className="text-[10px] text-muted">pane</span>}
                    </label>
                  ))}
                  <div className="my-1 h-px bg-border" />
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                    <input type="checkbox" checked={showEvents} onChange={() => setShowEvents(!showEvents)} className="accent-[var(--gold)]" />
                    <span className="flex-1">Market events</span>
                    <span className="flex gap-0.5" aria-hidden>
                      {(["fed", "inflation", "dollar", "shock"] as const).map((k) => <span key={k} className="h-2 w-2 rounded-full" style={{ background: EVENT_COLOR[k] }} />)}
                    </span>
                  </label>
                  <p className="px-2 pb-1 pt-1 text-[11px] text-muted">Events mark Fed decisions, inflation and jobs releases, and turning points like 2008 and 2020. Point at one to read it. Your picks are saved to your account.</p>
                </div>
              )}
            </div>
          )}
          <button onClick={() => setLogScale(!logScale)} aria-pressed={logScale}
            title={logScale ? "Switch to a normal price scale" : "Switch to a log scale, where equal % moves look the same size"}
            className={`rounded px-1.5 py-1 text-xs ${logScale ? "bg-background text-gold" : "text-muted hover:bg-background hover:text-foreground"}`}>
            Log
          </button>
          <button onClick={() => zoom(0.7)} className={btn} title="Zoom in" aria-label="Zoom in">
            <Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3M11 8v6M8 11h6" />
          </button>
          <button onClick={() => zoom(1 / 0.7)} className={btn} title="Zoom out" aria-label="Zoom out">
            <Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3M8 11h6" />
          </button>
          <button onClick={reset} className={btn} title="Back to latest" aria-label="Back to latest">
            <Icon d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
          </button>
          <button onClick={toggleFull} className={btn} title={full ? "Exit full screen" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"}>
            <Icon d={full ? "M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" : "M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"} />
          </button>
        </div>
        <div className="-mx-3 flex w-[calc(100%+1.5rem)] gap-3 overflow-x-auto px-3 pb-0.5">
          {GROUPS.filter((g) => market.has_seconds || g.label !== "Seconds").map((g) => (
            <div key={g.label} className="flex shrink-0 items-center gap-0.5" role="group" aria-label={g.label}>
              {g.tfs.map(([t, label]) => (
                <button
                  key={t}
                  onClick={() => pick(t)}
                  className={`rounded px-2 py-1 tabular-nums ${tf === t && !all ? "bg-gold text-black" : "text-muted hover:text-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
          {market.has_history && (
            <button onClick={showAll} title="Every month since 1833"
              className={`shrink-0 rounded px-2 py-1 ${all ? "bg-gold text-black" : "text-muted hover:text-foreground"}`}>
              All
            </button>
          )}
        </div>
      </div>
      {all && !error && (
        <p className="px-3 py-1.5 text-xs text-muted">
          Monthly prices since 1833. Before 1960 there is one price per year (official and market averages), and
          before the daily data starts each candle runs from one month&apos;s average to the next, so wicks are not real highs and lows.
        </p>
      )}
      {error && <p className="px-3 py-2 text-sm text-down">Couldn&apos;t load prices: {error}</p>}
      {empty && !error && (
        <p className="px-3 py-2 text-sm text-muted">
          {isSeconds(tf) || SIZE[tf]! < 3600
            ? "No bars here yet. Second and minute history fills in after the server's next price update."
            : "No prices loaded yet."}
        </p>
      )}
      <div className={`relative ${full ? "min-h-0 flex-1" : ""}`} style={full ? undefined : { height }}>
        <div ref={box} data-loading={loading} className="chart-swap h-full w-full" />
        {legend && (
          <div data-chart-legend className={`pointer-events-none absolute top-2 z-[1] flex flex-wrap gap-x-2.5 text-[11px] tabular-nums ${tools ? "left-14" : "left-3"}`}>
            {(["o", "h", "l", "c"] as const).map((k) => (
              <span key={k}><span className="text-muted">{k.toUpperCase()}</span> <span className={legend.c >= legend.o ? "text-up" : "text-down"}>{fmtPrice(legend[k])}</span></span>
            ))}
            <span className={legend.c >= legend.o ? "text-up" : "text-down"}>
              {legend.c >= legend.o ? "+" : ""}{(((legend.c - legend.o) / legend.o) * 100).toFixed(2)}%
            </span>
          </div>
        )}
        {hoverEvents.length > 0 && (
          <div className={`pointer-events-none absolute top-7 z-[1] max-w-[min(26rem,calc(100%-6rem))] space-y-1 rounded-lg border border-border bg-surface/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur ${tools ? "left-14" : "left-3"}`}>
            {hoverEvents.slice(0, 3).map((e, k) => (
              <p key={k} className="leading-snug">
                <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: EVENT_COLOR[e.kind] }} />
                <span className="font-medium">{e.title}</span>
                <span className="text-muted"> · {EVENT_NAME[e.kind]}{e.history ? "" : `, ${new Date(e.t * 1000).toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} UTC`}</span>
                {k === 0 && e.why && <span className="block text-muted">{e.why}</span>}
              </p>
            ))}
            {hoverEvents.length > 3 && <p className="text-muted">and {hoverEvents.length - 3} more</p>}
          </div>
        )}
        {tools && ready && <Drawings chart={ready.chart} series={ready.series} bars={barsRef} accent={accent} symbol={symbol} />}
        {ready && overlay?.({ ...ready, below })}
      </div>
      {overlay && <div ref={setBelow} />}
    </div>
  );
}
