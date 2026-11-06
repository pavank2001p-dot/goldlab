import type { ReplayBar, ReplaySettled, ReplayTradeIn } from "./api";

/** Where a replay trade ends. Mirrors the server's settle(), so the score on screen is the score it records:
 *  entries and manual exits fill at a bar's close; a later bar touching the stop or target closes it there
 *  (at the bar's open when it gapped through), the stop first when both are touched. */
export function settle(bars: ReplayBar[], t: ReplayTradeIn): ReplaySettled {
  const entry = bars[t.entry_bar].c;
  const long = t.side === "long";
  let exit = bars[t.exit_bar].c, exitBar = t.exit_bar, reason: ReplaySettled["reason"] = "closed";
  for (let i = t.entry_bar + 1; i <= t.exit_bar; i++) {
    const b = bars[i];
    if (t.stop != null && (long ? b.l <= t.stop : b.h >= t.stop)) {
      const gap = long ? b.o < t.stop : b.o > t.stop;
      exit = gap ? b.o : t.stop; exitBar = i; reason = "stop";
      break;
    }
    if (t.target != null && (long ? b.h >= t.target : b.l <= t.target)) {
      const gap = long ? b.o > t.target : b.o < t.target;
      exit = gap ? b.o : t.target; exitBar = i; reason = "target";
      break;
    }
  }
  const pnl = (exit - entry) * t.units * (long ? 1 : -1);
  return { ...t, entry_price: entry, exit_price: exit, exit_bar: exitBar, reason, pnl: Math.round(pnl * 100) / 100 };
}

/** Whether the bar at index i would close an open trade at its stop or target. */
export function hits(bar: ReplayBar, t: Pick<ReplayTradeIn, "side" | "stop" | "target">) {
  const long = t.side === "long";
  return (t.stop != null && (long ? bar.l <= t.stop : bar.h >= t.stop)) || (t.target != null && (long ? bar.h >= t.target : bar.l <= t.target));
}

export const TF_LABEL: Record<string, string> = { "5m": "5-minute", "15m": "15-minute", "1h": "hourly" };
