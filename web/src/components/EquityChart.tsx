"use client";

import { useEffect, useRef } from "react";
import { AreaSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import type { Report } from "@/lib/api";

export default function EquityChart({ equity, height = 360 }: { equity: Report["equity"]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current!;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: v("--surface") }, textColor: v("--muted") },
      grid: { vertLines: { color: v("--border") }, horzLines: { color: v("--border") } },
      rightPriceScale: { borderColor: v("--border") },
      timeScale: { borderColor: v("--border") },
      localization: { locale: "en-US" },
    });
    // Points can share a timestamp (a trade log closing two trades at once); keep the last.
    const dedupe = <T extends { time: UTCTimestamp }>(pts: T[]) =>
      pts.filter((p, i) => i === pts.length - 1 || pts[i + 1].time !== p.time);
    const eq = chart.addSeries(AreaSeries, {
      lineColor: v("--gold"),
      topColor: "rgba(227,179,65,0.25)",
      bottomColor: "rgba(227,179,65,0.02)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
    });
    eq.setData(dedupe(equity.map((p) => ({ time: p.t as UTCTimestamp, value: p.equity }))));
    const dd = chart.addSeries(
      AreaSeries,
      {
        lineColor: v("--down"),
        topColor: "rgba(239,83,80,0.05)",
        bottomColor: "rgba(239,83,80,0.35)",
        invertFilledArea: true,
        lineWidth: 1,
        priceFormat: { type: "custom", formatter: (x: number) => `${x.toFixed(1)}%` },
      },
      1,
    );
    dd.setData(dedupe(equity.map((p) => ({ time: p.t as UTCTimestamp, value: p.drawdown }))));
    chart.panes()[1]?.setHeight(Math.round(height * 0.28));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [equity, height]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex gap-4 border-b border-border px-3 py-2 text-xs text-muted">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-gold" />Account value</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-down" />Drawdown from peak</span>
      </div>
      <div ref={box} style={{ height }} />
    </div>
  );
}
