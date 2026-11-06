"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { useThemeKey } from "@/lib/theme";
import type { CustomPreview } from "@/lib/api";

const REPLAY_MS = 7000;

/** Candles with an arrow at every entry and a dot at every exit, so a rule change shows up as moved trades.
 *  Replay plays the period back candle by candle, with the trades appearing as they happen. */
export default function TradeChart({ data, height = 300 }: { data: CustomPreview; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const themeKey = useThemeKey();
  const parts = useRef<{ chart: IChartApi; series: ISeriesApi<"Candlestick">; markers: ISeriesMarkersPluginApi<Time>; marks: SeriesMarker<UTCTimestamp>[] } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(1);
  const [pnl, setPnl] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current!;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: v("--muted"), attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: v("--border") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: v("--surface-2") }, vertLine: { labelBackgroundColor: v("--surface-2") } },
      localization: { locale: "en-US" },
    });
    const s = chart.addSeries(CandlestickSeries, {
      upColor: v("--up"), downColor: v("--down"), borderVisible: false, wickUpColor: v("--up"), wickDownColor: v("--down"),
      priceLineVisible: false,
    });
    s.setData(data.candles.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })));
    const first = data.candles[0]?.t ?? 0;
    const marks: SeriesMarker<UTCTimestamp>[] = [];
    const labelled = data.trades.length <= 12; // words only when they won't pile up
    for (const t of data.trades) {
      if (t.entry_time >= first) {
        marks.push({
          time: t.entry_time as UTCTimestamp, position: t.side === "long" ? "belowBar" : "aboveBar",
          shape: t.side === "long" ? "arrowUp" : "arrowDown", color: t.side === "long" ? v("--up") : v("--down"),
          text: labelled ? (t.side === "long" ? "Buy" : "Sell") : undefined,
        });
      }
      if (t.exit_time != null && t.exit_time >= first) {
        marks.push({
          time: t.exit_time as UTCTimestamp, position: t.side === "long" ? "aboveBar" : "belowBar", shape: "circle",
          color: (t.pnl ?? 0) >= 0 ? v("--gold") : v("--muted"), size: 0.6,
        });
      }
    }
    marks.sort((a, b) => (a.time as number) - (b.time as number));
    const markers = createSeriesMarkers(s, marks);
    chart.timeScale().fitContent();
    parts.current = { chart, series: s, markers, marks };
    setPlaying(false);
    setProgress(1);
    setPnl(null);
    return () => {
      parts.current = null;
      chart.remove();
    };
  }, [data, themeKey]);

  // Replay: reveal candles and trades over a few seconds, with a running profit and loss.
  useEffect(() => {
    if (!playing || !parts.current) return;
    const { chart, series, markers, marks } = parts.current;
    const bars = data.candles.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }));
    const closed = data.trades.filter((t) => t.exit_time != null).sort((a, b) => a.exit_time! - b.exit_time!);
    const start = performance.now();
    let raf = 0, shown = 0;
    series.setData([]);
    markers.setMarkers([]);
    const tick = (now: number) => {
      const k = Math.min((now - start) / REPLAY_MS, 1);
      const n = Math.max(2, Math.round(bars.length * k));
      if (n !== shown) {
        shown = n;
        series.setData(bars.slice(0, n));
        const until = bars[n - 1].time;
        markers.setMarkers(marks.filter((m) => m.time <= until));
        chart.timeScale().fitContent();
        setPnl(closed.filter((t) => t.exit_time! <= until).reduce((a, t) => a + (t.pnl ?? 0), 0));
      }
      setProgress(k);
      if (k < 1 && parts.current) raf = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, data]);

  return (
    <div className="relative">
      <div ref={box} style={{ height }} className="w-full" />
      <div className="pointer-events-none absolute left-3 top-2 z-10 flex items-center gap-2">
        <button type="button" onClick={() => setPlaying(!playing)} aria-label={playing ? "Stop replay" : "Replay the trades"}
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-gold/40 bg-surface/90 px-3 py-1 text-xs font-medium text-gold shadow-lg backdrop-blur transition-colors hover:bg-gold/15">
          {playing
            ? <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            : <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden><path d="M7 4.5v15l12-7.5-12-7.5Z" /></svg>}
          {playing ? "Stop" : "Replay"}
        </button>
        {pnl != null && (
          <span className={`rounded-full bg-surface/90 px-2.5 py-1 text-xs font-semibold tabular-nums shadow-lg backdrop-blur ${pnl >= 0 ? "text-up" : "text-down"}`}>
            {pnl >= 0 ? "+" : "-"}${Math.abs(pnl).toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
        )}
      </div>
      {progress < 1 && (
        <div className="absolute inset-x-3 bottom-0 z-10 h-0.5 overflow-hidden rounded-full bg-border">
          <div className="h-full bg-gold" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}
