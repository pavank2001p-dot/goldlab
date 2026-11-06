"use client";

import { useEffect, useRef, useState } from "react";
import { api, fmtPrice, type LiveQuote, type Summary } from "@/lib/api";

export default function PriceTicker() {
  const [s, setS] = useState<Summary | null>(null);
  const [q, setQ] = useState<LiveQuote | null>(null);
  useEffect(() => {
    const load = () => api.summary().then(setS, () => {});
    const live = () => api.live().then(setQ, () => {});
    load();
    live();
    const t = setInterval(load, 60_000);
    const l = setInterval(live, 3_000);
    return () => {
      clearInterval(t);
      clearInterval(l);
    };
  }, []);

  // Prefer the live quote while it is fresh; the 24h change stays on the hourly history.
  const fresh = q?.price != null && (q.age_seconds ?? 999) < 60;
  const price = fresh ? q!.price! : s?.price ?? null;
  // Each new price glows briefly in the direction it moved.
  const last = useRef<number | null>(null);
  const [tick, setTick] = useState<{ dir: "up" | "down"; n: number } | null>(null);
  useEffect(() => {
    if (price == null) return;
    if (last.current != null && price !== last.current)
      setTick((t) => ({ dir: price > last.current! ? "up" : "down", n: (t?.n ?? 0) + 1 }));
    last.current = price;
  }, [price]);

  if (!s || price == null) return <div className="h-16" />;
  const up = (s.change_24h ?? 0) >= 0;
  const asOf = s.as_of ? new Date(s.as_of * 1000) : null;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-sm text-muted">XAU/USD</span>
        <span key={tick?.n ?? 0} className={`text-3xl font-semibold tabular-nums ${tick ? `tick-${tick.dir}` : ""}`}>${fmtPrice(price)}</span>
        {tick && (
          <span key={`a${tick.n}`} aria-hidden className={`rise-in -ml-1 text-sm ${tick.dir === "up" ? "text-up" : "text-down"}`}>
            {tick.dir === "up" ? "▲" : "▼"}
          </span>
        )}
        {s.change_24h != null && (
          <span className={`tabular-nums ${up ? "text-up" : "text-down"}`}>
            {up ? "+" : ""}
            {fmtPrice(s.change_24h)} ({up ? "+" : ""}
            {s.change_24h_pct!.toFixed(2)}%) 24h
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        {fresh ? <>Live quote. </> : asOf && <>Last hourly bar {asOf.toLocaleString()}. </>}
        {s.source === "sample" && (
          <span className="text-gold">Demo prices: real monthly levels with simulated hours, not live market data.</span>
        )}
      </p>
    </div>
  );
}
