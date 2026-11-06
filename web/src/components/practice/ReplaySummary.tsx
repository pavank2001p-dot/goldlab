"use client";

import { fmtPrice, fmtUsd, type ReplaySettled } from "@/lib/api";
import { SidePill } from "../ui";

export function summarize(done: ReplaySettled[], balance: number) {
  let cash = balance, peak = balance, dd = 0;
  for (const t of done) {
    cash += t.pnl;
    peak = Math.max(peak, cash);
    dd = Math.max(dd, ((peak - cash) / peak) * 100);
  }
  const wins = done.filter((t) => t.pnl > 0).length;
  return { balance: cash, return_pct: (cash / balance - 1) * 100, max_drawdown_pct: dd, trades: done.length, wins,
    stops: done.filter((t) => t.stop != null).length };
}

const REASON = { closed: "You closed it", stop: "Stop", target: "Target" } as const;

/** What a finished replay came to, and each trade in it. */
export default function ReplaySummary({ done, balance, children }: { done: ReplaySettled[]; balance: number; children?: React.ReactNode }) {
  const s = summarize(done, balance);
  const tiles = [
    { label: "Result", value: `${s.return_pct >= 0 ? "+" : ""}${s.return_pct.toFixed(2)}%`, tone: s.return_pct >= 0 ? "text-up" : "text-down" },
    { label: "Trades", value: String(s.trades) },
    { label: "Won", value: s.trades ? `${Math.round((s.wins / s.trades) * 100)}%` : "–" },
    { label: "Deepest dip", value: `${s.max_drawdown_pct.toFixed(2)}%` },
    { label: "With a stop", value: s.trades ? `${s.stops} of ${s.trades}` : "–" },
  ];
  return (
    <section className="card rise-in p-5">
      <h2 className="text-lg font-semibold">How it went</h2>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl bg-background/50 p-3">
            <p className="text-xs text-muted">{t.label}</p>
            <p className={`mt-0.5 text-lg font-semibold tabular-nums ${t.tone ?? ""}`}>{t.value}</p>
          </div>
        ))}
      </div>
      {children}
      {done.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr><th className="py-1.5 font-normal">Side</th><th className="font-normal">Size</th><th className="font-normal">Entry</th><th className="font-normal">Exit</th><th className="font-normal">How it ended</th><th className="text-right font-normal">Result</th></tr>
            </thead>
            <tbody>
              {done.map((t, k) => (
                <tr key={k} className="border-t border-border tabular-nums">
                  <td className="py-1.5"><SidePill side={t.side} /></td>
                  <td>{t.units} oz</td>
                  <td>{fmtPrice(t.entry_price)}</td>
                  <td>{fmtPrice(t.exit_price)}</td>
                  <td className="text-muted">{REASON[t.reason]}</td>
                  <td className={`text-right ${t.pnl >= 0 ? "text-up" : "text-down"}`}>{t.pnl >= 0 ? "+" : ""}{fmtUsd(t.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="mt-4 text-sm text-muted">No trades this time. Sitting out is a decision too, and often a good one.</p>}
    </section>
  );
}
