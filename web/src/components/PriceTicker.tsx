"use client";

import { useEffect, useState } from "react";
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

  if (!s || s.price == null) return <div className="h-16" />;
  // Prefer the live quote while it is fresh; the 24h change stays on the hourly history.
  const fresh = q?.price != null && (q.age_seconds ?? 999) < 60;
  const price = fresh ? q!.price! : s.price;
  const up = (s.change_24h ?? 0) >= 0;
  const asOf = s.as_of ? new Date(s.as_of * 1000) : null;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-sm text-muted">XAU/USD</span>
        <span className="text-3xl font-semibold tabular-nums">${fmtPrice(price)}</span>
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
