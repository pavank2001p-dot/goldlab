"use client";

import { useState } from "react";
import EquityChart from "./EquityChart";
import { fmtDate, fmtPct, fmtUsd, type Report } from "@/lib/api";

const REASONS: Record<string, string> = {
  signal: "Signal",
  stop_loss: "Stop loss",
  take_profit: "Take profit",
  end_of_test: "End of test",
  account_wiped_out: "Account wiped out",
};

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: "up" | "down"; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3" title={hint}>
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : ""}`}>
        {value}
      </p>
    </div>
  );
}

const tone = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? "up" : "down");

export default function ReportView({ report, kind }: { report: Report; kind: "backtest" | "log" }) {
  const s = report.stats;
  const [showAll, setShowAll] = useState(false);
  const trades = [...report.trades].reverse();
  const shown = showAll ? trades : trades.slice(0, 50);

  if (!s.trades)
    return (
      <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
        {kind === "log" ? "Close at least one trade to see your report." : "This strategy made no trades in that period."}
      </p>
    );

  return (
    <div className="space-y-4">
      {s.wiped_out && (
        <p className="rounded-lg border border-down/50 bg-down/10 p-3 text-sm">
          The account ran out of money during this test, so it stopped early. The trade size is too large for the
          starting capital; try fewer ounces per trade or a stop loss.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Net profit" value={fmtUsd(s.net_profit)} tone={tone(s.net_profit)} />
        <Stat label="Return" value={fmtPct(s.total_return_pct)} tone={tone(s.total_return_pct)}
              hint={s.cagr_pct != null ? `${fmtPct(s.cagr_pct)} a year` : undefined} />
        <Stat label="Max drawdown" value={fmtPct(s.max_drawdown_pct)} tone="down" hint={fmtUsd(s.max_drawdown_usd)} />
        <Stat label="Win rate" value={fmtPct(s.win_rate_pct)} hint={`${s.trades} trades`} />
        <Stat label="Profit factor" value={s.profit_factor?.toFixed(2) ?? "–"}
              hint="Gross profit divided by gross loss. Above 1 means winners outweigh losers." />
        <Stat label="Avg win / avg loss" value={`${fmtUsd(s.avg_win)} / ${fmtUsd(s.avg_loss)}`} />
        <Stat label="Sharpe ratio" value={s.sharpe?.toFixed(2) ?? "–"}
              hint="Return per unit of daily volatility, annualised. Above 1 is good." />
        {kind === "backtest" ? (
          <Stat label="Buy and hold" value={fmtPct(s.buy_and_hold_pct)} hint="Gold's own move over the same period" />
        ) : (
          <Stat label="Longest losing streak" value={`${s.longest_losing_streak} trades`} />
        )}
      </div>
      <p className="text-xs text-muted">
        {s.trades} trades · average hold {s.avg_hold_hours != null ? `${s.avg_hold_hours.toFixed(1)} h` : "–"} · costs{" "}
        {fmtUsd(s.total_costs)} · swap {fmtUsd(s.total_swap)}
        {kind === "backtest" && s.time_in_market_pct != null && <> · in the market {fmtPct(s.time_in_market_pct)} of the time</>}
        {s.cagr_pct != null && <> · {fmtPct(s.cagr_pct)} a year</>}
        {kind === "backtest" && <> · longest losing streak {s.longest_losing_streak}</>}
      </p>

      <EquityChart equity={report.equity} />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm tabular-nums">
          <thead className="bg-surface text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2">Side</th>
              <th className="px-3 py-2">Opened (UTC)</th>
              <th className="px-3 py-2 text-right">Entry</th>
              <th className="px-3 py-2">Closed (UTC)</th>
              <th className="px-3 py-2 text-right">Exit</th>
              <th className="px-3 py-2 text-right">Oz</th>
              <th className="px-3 py-2 text-right">Swap</th>
              <th className="px-3 py-2 text-right">P&amp;L</th>
              {kind === "backtest" && <th className="px-3 py-2">Exit reason</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={i} className="border-t border-border">
                <td className={`px-3 py-1.5 ${t.side === "long" ? "text-up" : "text-down"}`}>{t.side}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{fmtDate(t.entry_time)}</td>
                <td className="px-3 py-1.5 text-right">{t.entry_price.toFixed(2)}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{fmtDate(t.exit_time)}</td>
                <td className="px-3 py-1.5 text-right">{t.exit_price.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right">{t.units}</td>
                <td className="px-3 py-1.5 text-right">{fmtUsd(t.swap)}</td>
                <td className={`px-3 py-1.5 text-right ${t.pnl >= 0 ? "text-up" : "text-down"}`}>{fmtUsd(t.pnl)}</td>
                {kind === "backtest" && <td className="whitespace-nowrap px-3 py-1.5 text-muted">{REASONS[t.exit_reason ?? ""] ?? t.exit_reason}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {trades.length > 50 && !showAll && (
        <button onClick={() => setShowAll(true)} className="text-sm text-gold">
          Show all {trades.length} trades
        </button>
      )}
    </div>
  );
}
