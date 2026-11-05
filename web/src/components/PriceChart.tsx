"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { api, fmtPrice, type Bar, type ChartTf, type LiveQuote } from "@/lib/api";

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

export default function PriceChart({ height = 520, initialTf = "1h" }: { height?: number; initialTf?: ChartTf }) {
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [tf, setTf] = useState<ChartTf>(initialTf);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [full, setFull] = useState(false);
  const [quote, setQuote] = useState<LiveQuote | null>(null);

  // Create the chart once.
  useEffect(() => {
    const el = box.current!;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: v("--surface") }, textColor: v("--muted") },
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
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

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
    series.setData([]);
    chart.applyOptions({ timeScale: { secondsVisible: isSeconds(tf) } });

    api.candles(tf, { limit: PAGE }).then(
      (data) => {
        if (cancelled) return;
        bars = data;
        setEmpty(!data.length);
        series.setData(bars.map(toCandle));
        chart.timeScale().setVisibleLogicalRange({ from: bars.length - VISIBLE, to: bars.length + 5 });
      },
      (e) => !cancelled && setError(e.message),
    );

    const onRange = async (range: { from: number } | null) => {
      if (!range || range.from > 50 || loadingOlder || reachedStart || !bars.length) return;
      loadingOlder = true;
      try {
        const older = await api.candles(tf, { end: bars[0].t, limit: PAGE });
        if (cancelled) return;
        if (!older.length) reachedStart = true;
        else {
          bars = [...older, ...bars];
          series.setData(bars.map(toCandle));
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
        const fresh = await api.candles(tf, { start: bars[bars.length - 1].t, limit: 500 });
        if (cancelled) return;
        for (const b of fresh) {
          if (b.t < bars[bars.length - 1].t) continue;
          series.update(toCandle(b));
          if (b.t === bars[bars.length - 1].t) bars[bars.length - 1] = b;
          else bars.push(b);
        }
      } catch {}
    }, isSeconds(tf) ? 15_000 : 60_000);

    const poll = setInterval(async () => {
      try {
        const q = await api.live();
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
  }, [tf]);

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
      className={`flex flex-col overflow-hidden border border-border bg-surface ${full ? "fixed inset-0 z-50" : "rounded-lg"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2 text-sm">
        <span className="font-medium">XAU/USD</span>
        {quote?.configured && (
          <span className="flex items-center gap-1.5 text-xs">
            <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-up" : "bg-muted"}`} />
            {live ? (
              <span className="tabular-nums">Live ${fmtPrice(quote!.price!)}</span>
            ) : (
              <span className="text-muted">{quote.connected ? "Market closed" : "Live feed offline"}</span>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
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
          {GROUPS.map((g) => (
            <div key={g.label} className="flex shrink-0 items-center gap-0.5" role="group" aria-label={g.label}>
              {g.tfs.map(([t, label]) => (
                <button
                  key={t}
                  onClick={() => setTf(t)}
                  className={`rounded px-2 py-1 tabular-nums ${tf === t ? "bg-gold text-black" : "text-muted hover:text-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      {error && <p className="px-3 py-2 text-sm text-down">Couldn&apos;t load prices: {error}</p>}
      {empty && !error && (
        <p className="px-3 py-2 text-sm text-muted">
          {isSeconds(tf) || SIZE[tf]! < 3600
            ? "No bars here yet. Second and minute history fills in after the server's next price update."
            : "No prices loaded yet."}
        </p>
      )}
      <div ref={box} className={full ? "min-h-0 flex-1" : ""} style={full ? undefined : { height }} />
    </div>
  );
}
