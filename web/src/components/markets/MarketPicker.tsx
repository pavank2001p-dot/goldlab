"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Market } from "@/lib/api";
import { fmtMarketPrice, labName, ticker } from "@/lib/markets";
import { Icon } from "@/components/ui";

/** A compact button showing the current market; it opens a searchable list grouped by lab. */
export default function MarketPicker({ market, markets, onChange, className = "" }: {
  market: Market; markets: Market[]; onChange: (symbol: string) => void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (m: Market) => !needle || m.name.toLowerCase().includes(needle) || m.symbol.toLowerCase().includes(needle)
      || ticker(m).toLowerCase().includes(needle) || m.class_label.toLowerCase().includes(needle) || labName(m).toLowerCase().includes(needle);
    const out: { label: string; items: Market[] }[] = [];
    for (const m of markets.filter(hit)) {
      // Grouped by lab: Commodity Lab holds metals and energy, then Forex, Index, Stock and Crypto Lab.
      const g = out.find((x) => x.label === labName(m));
      if (g) g.items.push(m);
      else out.push({ label: labName(m), items: [m] });
    }
    return out;
  }, [markets, q]);

  const pick = (s: string) => { onChange(s); setOpen(false); setQ(""); };

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm transition hover:border-muted">
        <span className="font-medium">{market.name}</span>
        <span className="text-xs text-muted">{ticker(market) !== market.name ? ticker(market) : market.class_label}</span>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted" fill="none" stroke="currentColor" strokeWidth={2}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1.5 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Icon name="search" className="h-4 w-4 text-muted" />
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search markets"
              className="w-full bg-transparent py-2.5 text-base outline-none sm:text-sm"
              onKeyDown={(e) => { if (e.key === "Enter" && groups[0]?.items[0]) pick(groups[0].items[0].symbol); }} />
          </div>
          <ul role="listbox" className="max-h-80 overflow-y-auto py-1">
            {groups.map((g) => (
              <li key={g.label}>
                <p className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-muted">{g.label}</p>
                <ul>
                  {g.items.map((m) => (
                    <li key={m.symbol}>
                      <button type="button" role="option" aria-selected={m.symbol === market.symbol} onClick={() => pick(m.symbol)}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-background ${m.symbol === market.symbol ? "text-gold" : ""}`}>
                        <span className="truncate">{m.name}</span>
                        {ticker(m) !== m.name && <span className="text-xs text-muted">{ticker(m)}</span>}
                        <span className="ml-auto tabular-nums text-xs text-muted">{m.price != null ? fmtMarketPrice(m.price, m) : ""}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {!groups.length && <li className="px-3 py-3 text-sm text-muted">No market matches &ldquo;{q}&rdquo;.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
