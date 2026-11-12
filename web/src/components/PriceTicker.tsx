"use client";

import { useEffect, useRef, useState } from "react";
import { api, type LiveQuote, type Market, type Summary } from "@/lib/api";
import { GOLD, fmtMarketPrice, ticker } from "@/lib/markets";
import { useT } from "@/lib/i18n";
import { UNIT_NAMES, convert, fmtLocal, useLocalPrice } from "@/lib/localPrice";

export default function PriceTicker({ market = GOLD }: { market?: Market }) {
  const symbol = market.symbol;
  const fmtPrice = (p: number) => fmtMarketPrice(p, market);
  const [s, setS] = useState<Summary | null>(null);
  const [q, setQ] = useState<LiveQuote | null>(null);
  const last = useRef<number | null>(null);
  const { t, lang } = useT();
  const { pref, fx, local } = useLocalPrice();
  useEffect(() => {
    setS(null);
    setQ(null);
    last.current = null;
    const load = () => api.summary(symbol).then((v) => v.symbol === symbol && setS(v), () => {});
    const live = () => api.live(symbol).then(setQ, () => {});
    load();
    live();
    const t = setInterval(load, 60_000);
    const l = setInterval(live, 3_000);
    return () => {
      clearInterval(t);
      clearInterval(l);
    };
  }, [symbol]);

  // Prefer the live quote while it is fresh; the 24h change stays on the hourly history.
  const fresh = q?.price != null && (q.age_seconds ?? 999) < 60;
  const price = fresh ? q!.price! : s?.price ?? null;
  // Each new price glows briefly in the direction it moved.
  const [tick, setTick] = useState<{ dir: "up" | "down"; n: number } | null>(null);
  useEffect(() => {
    if (price == null) return;
    if (last.current != null && price !== last.current)
      setTick((t) => ({ dir: price > last.current! ? "up" : "down", n: (t?.n ?? 0) + 1 }));
    last.current = price;
  }, [price]);

  if (!s) return <div className="h-16" />;
  if (price == null)
    return (
      <div className="h-16 text-sm text-muted">
        No {market.name} prices loaded yet. They fill in after the server&apos;s next price update.
      </div>
    );
  const up = (s.change_24h ?? 0) >= 0;
  const asOf = s.as_of ? new Date(s.as_of * 1000) : null;
  // Only gold quoted in dollars per ounce converts cleanly into a local price per gram or tola.
  const localPrice = local && symbol === GOLD.symbol ? convert(price, pref, fx) : null;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-sm text-muted">{ticker(market)}</span>
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
      {localPrice != null && (
        <p className="mt-1 text-lg font-medium tabular-nums" title={t("Spot price at today's exchange rate, before local taxes, duties and making charges.")}>
          {t("≈ {price} per {unit}", { price: fmtLocal(localPrice, pref.currency, lang), unit: t(UNIT_NAMES[pref.unit]) })}
          <span className="ms-2 text-xs font-normal text-muted">
            {fx?.source === "fallback"
              ? t("Rough exchange rate; today's rate couldn't be loaded.")
              : t("Spot price at today's exchange rate, before local taxes, duties and making charges.")}
          </span>
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        {fresh ? <>{t("Live quote.")} </> : asOf && <>{t("Last hourly bar {time}.", { time: asOf.toLocaleString() })} </>}
        {s.source === "sample" && (
          <span className="text-gold">
            {symbol === GOLD.symbol
              ? "Demo prices: real monthly levels with simulated hours, not live market data."
              : "Demo prices: simulated from gold's monthly path, not live market data."}
          </span>
        )}
      </p>
    </div>
  );
}
