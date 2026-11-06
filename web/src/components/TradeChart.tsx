"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, type SeriesMarker, type UTCTimestamp } from "lightweight-charts";
import { useThemeKey } from "@/lib/theme";
import type { CustomPreview } from "@/lib/api";

/** Candles with an arrow at every entry and a dot at every exit, so a rule change shows up as moved trades. */
export default function TradeChart({ data, height = 300 }: { data: CustomPreview; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const themeKey = useThemeKey();

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
    createSeriesMarkers(s, marks);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, themeKey]);

  return <div ref={box} style={{ height }} className="w-full" />;
}
