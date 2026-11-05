"use client";

import { useState } from "react";
import EquityChart from "./EquityChart";
import { Chips, CountUp, Icon, SidePill } from "./ui";
import { fmtDate, fmtPct, fmtUsd, type Report } from "@/lib/api";

const REASONS: Record<string, string> = {
  signal: "Signal",
  stop_loss: "Stop loss",
  take_profit: "Take profit",
  end_of_test: "End of test",
  account_wiped_out: "Account wiped out",
};

function Stat({ label, value, num, fmt, tone, hint, icon }: {
  label: string; value?: string; num?: number | null; fmt?: (v: number) => string; tone?: "up" | "down"; hint?: string; icon: string;
}) {
  const colour = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "";
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-surface p-3.5 transition hover:border-muted" title={hint}>
      <div className="flex items-center justify-between text-xs text-muted">
        {label}
        <Icon name={icon} className={`h-4 w-4 opacity-60 ${colour}`} />
      </div>
      <p className={`mt-1.5 break-words text-lg font-semibold leading-tight tabular-nums ${colour}`}>
        {num != null && fmt ? <CountUp value={num} format={fmt} /> : value}
      </p>
      {hint && <p className="mt-0.5 hidden text-[11px] leading-snug text-muted group-hover:block">{hint}</p>}
      <span className={`absolute inset-x-0 bottom-0 h-0.5 ${tone === "up" ? "bg-up/60" : tone === "down" ? "bg-down/60" : "bg-gold/30"}`} />
    </div>
  );
}

/** Wins vs losses as a ring. */
function WinRing({ pct, wins, losses }: { pct: number; wins: number; losses: number }) {
  const r = 30, c = 2 * Math.PI * r;
  return (
    <div className="flex items-center justify-center gap-4 rounded-xl border border-border bg-surface p-4">
      <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90" aria-hidden>
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--down)" strokeOpacity={0.35} strokeWidth={9} />
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--up)" strokeWidth={9} strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`} className="ring-draw" />
      </svg>
      <div>
        <p className="text-2xl font-semibold tabular-nums"><CountUp value={pct} format={(v) => `${v.toFixed(0)}%`} /></p>
        <p className="text-xs text-muted">of trades won</p>
        <p className="mt-1 text-xs tabular-nums"><span className="text-up">{wins} {wins === 1 ? "win" : "wins"}</span> · <span className="text-down">{losses} {losses === 1 ? "loss" : "losses"}</span></p>
      </div>
    </div>
  );
}

type Filter = "all" | "wins" | "losses" | "long" | "short";

const tone = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? "up" : "down");

export default function ReportView({ report, kind }: { report: Report; kind: "backtest" | "log" }) {
  const s = report.stats;
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const all = [...report.trades].reverse();
  const keep = (t: (typeof all)[number]) =>
    filter === "all" || (filter === "wins" ? t.pnl > 0 : filter === "losses" ? t.pnl <= 0 : t.side === filter);
  const trades = all.filter(keep);
  const shown = showAll ? trades : trades.slice(0, 50);
  const maxAbs = Math.max(...all.map((t) => Math.abs(t.pnl)), 1);
  const wins = all.filter((t) => t.pnl > 0).length;

  if (!s.trades)
    return (
      <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">
        {kind === "log" ? "Close at least one trade to see your report." : "This strategy made no trades in that period."}
      </p>
    );

  return (
    <div className="@container space-y-4">
      {s.wiped_out && (
        <p className="rounded-lg border border-down/50 bg-down/10 p-3 text-sm">
          The account ran out of money during this test, so it stopped early. The trade size is too large for the
          starting capital; try fewer ounces per trade or a stop loss.
        </p>
      )}
      <div className="grid gap-3 @4xl:grid-cols-[1fr_220px]">
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
          <Stat icon="wallet" label="Net profit" num={s.net_profit} fmt={(v) => fmtUsd(v)} tone={tone(s.net_profit)} />
          <Stat icon="percent" label="Return" num={s.total_return_pct} fmt={(v) => fmtPct(v)} tone={tone(s.total_return_pct)}
                hint={s.cagr_pct != null ? `${fmtPct(s.cagr_pct)} a year` : undefined} />
          <Stat icon="drop" label="Max drawdown" num={s.max_drawdown_pct} fmt={(v) => fmtPct(v)} tone="down" hint={`Largest fall from a peak: ${fmtUsd(s.max_drawdown_usd)}`} />
          <Stat icon="scale" label="Profit factor" value={s.profit_factor?.toFixed(2) ?? "–"}
                hint="Gross profit divided by gross loss. Above 1 means winners outweigh losers." />
          <Stat icon="trophy" label="Avg win / avg loss" value={`${fmtUsd(s.avg_win)} / ${fmtUsd(s.avg_loss)}`} />
          <Stat icon="bolt" label="Sharpe ratio" value={s.sharpe?.toFixed(2) ?? "–"}
                hint="Return per unit of daily volatility, annualised. Above 1 is good." />
          {kind === "backtest" ? (
            <Stat icon="layers" label="Buy and hold" num={s.buy_and_hold_pct} fmt={(v) => fmtPct(v)} tone={tone(s.buy_and_hold_pct)} hint="Gold's own move over the same period" />
          ) : (
            <Stat icon="drop" label="Longest losing streak" value={`${s.longest_losing_streak} trades`} />
          )}
          <Stat icon="clock" label="Average hold" value={s.avg_hold_hours != null ? (s.avg_hold_hours >= 48 ? `${(s.avg_hold_hours / 24).toFixed(1)} days` : `${s.avg_hold_hours.toFixed(1)} h`) : "–"} />
        </div>
        <WinRing pct={s.win_rate_pct ?? 0} wins={wins} losses={all.length - wins} />
      </div>
      <p className="text-xs text-muted">
        {s.trades} trades · average hold {s.avg_hold_hours != null ? `${s.avg_hold_hours.toFixed(1)} h` : "–"} · costs{" "}
        {fmtUsd(s.total_costs)} · swap {fmtUsd(s.total_swap)}
        {kind === "backtest" && s.time_in_market_pct != null && <> · in the market {fmtPct(s.time_in_market_pct)} of the time</>}
        {s.cagr_pct != null && <> · {fmtPct(s.cagr_pct)} a year</>}
        {kind === "backtest" && <> · longest losing streak {s.longest_losing_streak}</>}
      </p>

      <EquityChart equity={report.equity} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Trades</h3>
        <Chips<Filter> value={filter} onChange={(v) => { setFilter(v); setShowAll(false); }} options={[
          { key: "all", label: "All", count: all.length },
          { key: "wins", label: "Winners", count: wins, dot: "var(--up)" },
          { key: "losses", label: "Losers", count: all.length - wins, dot: "var(--down)" },
          { key: "long", label: "Long", count: all.filter((t) => t.side === "long").length },
          { key: "short", label: "Short", count: all.filter((t) => t.side === "short").length },
        ]} />
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
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
              <tr key={i} className="border-t border-border transition-colors hover:bg-surface">
                <td className="px-3 py-1.5"><SidePill side={t.side} /></td>
                <td className="whitespace-nowrap px-3 py-1.5">{fmtDate(t.entry_time)}</td>
                <td className="px-3 py-1.5 text-right">{t.entry_price.toFixed(2)}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{fmtDate(t.exit_time)}</td>
                <td className="px-3 py-1.5 text-right">{t.exit_price.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right">{t.units}</td>
                <td className="px-3 py-1.5 text-right">{fmtUsd(t.swap)}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center justify-end gap-2">
                    <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-border @4xl:block">
                      <span className={`block h-full rounded-full ${t.pnl >= 0 ? "ml-auto bg-up" : "bg-down"}`} style={{ width: `${(Math.abs(t.pnl) / maxAbs) * 100}%` }} />
                    </span>
                    <span className={t.pnl >= 0 ? "text-up" : "text-down"}>{fmtUsd(t.pnl)}</span>
                  </div>
                </td>
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
