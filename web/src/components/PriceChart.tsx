"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { api, type Bar, type Timeframe } from "@/lib/api";

const REFRESH_MS = 60_000;
const PAGE = { "1h": 2000, "1d": 5000 } as const;

// Some browsers report locales Intl rejects (e.g. "en-US@posix"); fall back to en-US.
function safeLocale() {
  try {
    return Intl.NumberFormat.supportedLocalesOf([navigator.language])[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

const toCandle = (b: Bar): CandlestickData => ({
  time: b.t as UTCTimestamp,
  open: b.o,
  high: b.h,
  low: b.l,
  close: b.c,
});

export default function PriceChart({ height = 520, initialTf = "1h" }: { height?: number; initialTf?: Timeframe }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [tf, setTf] = useState<Timeframe>(initialTf);
  const [error, setError] = useState<string | null>(null);

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

  // Load data for the selected timeframe, page in older bars on scroll, refresh the tail.
  useEffect(() => {
    const chart = chartRef.current!;
    const series = seriesRef.current!;
    let bars: Bar[] = [];
    let loadingOlder = false;
    let reachedStart = false;
    let cancelled = false;
    setError(null);
    series.setData([]);

    api.candles(tf, { limit: PAGE[tf] }).then(
      (data) => {
        if (cancelled) return;
        bars = data;
        series.setData(bars.map(toCandle));
        const visible = tf === "1h" ? 24 * 10 : 250;
        chart.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length + 3 });
      },
      (e) => !cancelled && setError(e.message),
    );

    const onRange = async (range: { from: number } | null) => {
      if (!range || range.from > 50 || loadingOlder || reachedStart || !bars.length) return;
      loadingOlder = true;
      try {
        const older = await api.candles(tf, { end: bars[0].t, limit: PAGE[tf] });
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

    const timer = setInterval(async () => {
      if (!bars.length) return;
      const last = bars[bars.length - 1].t;
      try {
        const fresh = await api.candles(tf, { start: last, limit: 500 });
        if (cancelled) return;
        for (const b of fresh) {
          series.update(toCandle(b));
          if (b.t === bars[bars.length - 1].t) bars[bars.length - 1] = b;
          else bars.push(b);
        }
      } catch {}
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
    };
  }, [tf]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <span className="font-medium">XAU/USD</span>
        <div className="ml-auto flex gap-1">
          {(["1h", "1d"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`rounded px-2.5 py-1 ${tf === t ? "bg-gold text-black" : "text-muted hover:text-foreground"}`}
            >
              {t === "1h" ? "1H" : "1D"}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="px-3 py-2 text-sm text-down">Couldn&apos;t load prices: {error}</p>}
      <div ref={box} style={{ height }} />
    </div>
  );
}
