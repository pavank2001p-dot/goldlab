"use client";

import { useEffect, useState } from "react";
import { fmtPrice, fmtUsd } from "@/lib/api";
import { Icon } from "../ui";

const field = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-gold";

/** How big a trade should be so that hitting the stop costs a chosen share of the account.
 *  Gold is quoted per troy ounce; a standard lot is 100 oz, a mini lot 10 oz and a micro lot 1 oz. */
export default function SizeCalculator({ equity, leverage, price, riskPct = 1, onUse }: {
  equity: number; leverage: number; price: number | null; riskPct?: number; onUse?: (oz: number) => void;
}) {
  const [account, setAccount] = useState(String(Math.round(equity)));
  const [risk, setRisk] = useState(String(riskPct));
  const [entry, setEntry] = useState(price ? price.toFixed(2) : "");
  const [stop, setStop] = useState(price ? (price - 10).toFixed(2) : "");
  useEffect(() => { if (price && !entry) { setEntry(price.toFixed(2)); setStop((price - 10).toFixed(2)); } }, [price, entry]);

  const acc = Number(account), r = Number(risk), e = Number(entry), s = Number(stop);
  const dist = Math.abs(e - s);
  const ok = acc > 0 && r > 0 && e > 0 && s > 0 && dist > 0;
  const money = ok ? (acc * r) / 100 : 0;
  const oz = ok ? Math.floor((money / dist) * 100) / 100 : 0;
  const value = oz * e;
  const margin = value / leverage;
  const tooBig = ok && margin > acc;
  const rows: [string, string][] = ok ? [
    ["Size", `${oz.toLocaleString("en-US")} oz (${(oz / 100).toFixed(2)} lots)`],
    ["Lose if the stop is hit", fmtUsd(oz * dist)],
    ["Each $1 gold moves", fmtUsd(oz)],
    ["Position value", fmtUsd(value)],
    [`Margin at 1:${leverage}`, fmtUsd(margin)],
  ] : [];

  return (
    <details className="card group p-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
        <Icon name="scale" className="h-4 w-4 text-gold" /> Position size calculator
        <Icon name="down" className="ml-auto h-4 w-4 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <label><span className="text-muted">Account ($)</span><input inputMode="decimal" value={account} onChange={(x) => setAccount(x.target.value)} className={field} /></label>
        <label><span className="text-muted">Risk per trade (%)</span><input inputMode="decimal" value={risk} onChange={(x) => setRisk(x.target.value)} className={field} /></label>
        <label><span className="text-muted">Entry price</span><input inputMode="decimal" value={entry} onChange={(x) => setEntry(x.target.value)} className={field} /></label>
        <label><span className="text-muted">Stop price</span><input inputMode="decimal" value={stop} onChange={(x) => setStop(x.target.value)} className={field} /></label>
      </div>
      {ok ? (
        <>
          <dl className="mt-3 space-y-1 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{k}</dt><dd className="font-medium tabular-nums">{v}</dd></div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-muted">
            A {e > s ? "buy" : "sell"} at {fmtPrice(e)} with the stop {fmtUsd(dist)} away. {tooBig ? "That needs more margin than the account has, so pick a wider stop or a smaller risk." : "Sizing from the stop keeps every loss the same, whatever the setup."}
          </p>
          {onUse && oz > 0 && (
            <button type="button" onClick={() => onUse(oz)} className="mt-3 w-full rounded-full border border-gold/40 py-1.5 text-sm text-gold hover:bg-gold/10">Use {oz} oz in the order ticket</button>
          )}
        </>
      ) : <p className="mt-3 text-xs text-muted">Fill in all four to see the size.</p>}
    </details>
  );
}
