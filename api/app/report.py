"""Performance report shared by backtests and the trade log, so both read the same way."""

import math
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
MAX_CURVE_POINTS = 1500


def trading_date(t: int):
    """Gold's trading day ends at 17:00 New York; bars after that belong to the next day."""
    return (datetime.fromtimestamp(t, timezone.utc).astimezone(NY) + timedelta(hours=7)).date()


def _downsample(points: Sequence[dict], limit: int = MAX_CURVE_POINTS) -> list[dict]:
    if len(points) <= limit:
        return list(points)
    step = len(points) / limit
    out = [points[int(i * step)] for i in range(limit)]
    if out[-1] is not points[-1]:
        out.append(points[-1])
    return out


def build_report(trades: list[dict], equity: list[tuple[int, float]], capital: float) -> dict:
    """trades: dicts with side, units, entry_time, exit_time, pnl, costs, swap (times in unix seconds).
    equity: (unix seconds, account value) in time order, starting at `capital`."""
    closed = [t for t in trades if t.get("exit_time") is not None]
    wins = [t["pnl"] for t in closed if t["pnl"] > 0]
    losses = [t["pnl"] for t in closed if t["pnl"] <= 0]
    gross_win, gross_loss = sum(wins), -sum(losses)

    # Drawdown from the running peak.
    curve, peak, max_dd, max_dd_usd = [], capital, 0.0, 0.0
    for t, v in equity:
        peak = max(peak, v)
        dd = (v - peak) / peak * 100 if peak > 0 else 0.0
        max_dd = min(max_dd, dd)
        max_dd_usd = min(max_dd_usd, v - peak)
        curve.append({"t": t, "equity": round(v, 2), "drawdown": round(dd, 3)})

    final = equity[-1][1] if equity else capital
    years = (equity[-1][0] - equity[0][0]) / (365.25 * 86400) if len(equity) > 1 else 0
    cagr = ((final / capital) ** (1 / years) - 1) * 100 if years >= 0.25 and final > 0 and capital > 0 else None

    # Sharpe from end-of-trading-day equity.
    daily: dict = {}
    for t, v in equity:
        daily[trading_date(t)] = v
    vals = list(daily.values())
    rets = [b / a - 1 for a, b in zip(vals, vals[1:]) if a > 0]
    sharpe = None
    if len(rets) > 20:
        mean = sum(rets) / len(rets)
        sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
        sharpe = mean / sd * math.sqrt(252) if sd > 0 else None

    streak = worst_streak = 0
    for t in closed:
        streak = streak + 1 if t["pnl"] <= 0 else 0
        worst_streak = max(worst_streak, streak)

    holds = [(t["exit_time"] - t["entry_time"]) / 3600 for t in closed]
    n = len(closed)
    r2 = lambda x: None if x is None else round(x, 2)  # noqa: E731
    stats = {
        "starting_capital": r2(capital),
        "final_equity": r2(final),
        "net_profit": r2(final - capital),
        "total_return_pct": r2((final / capital - 1) * 100) if capital else None,
        "cagr_pct": r2(cagr),
        "max_drawdown_pct": r2(max_dd),
        "max_drawdown_usd": r2(max_dd_usd),
        "sharpe": r2(sharpe),
        "trades": n,
        "win_rate_pct": r2(len(wins) / n * 100) if n else None,
        "profit_factor": r2(gross_win / gross_loss) if gross_loss > 0 else None,
        "avg_win": r2(gross_win / len(wins)) if wins else None,
        "avg_loss": r2(-gross_loss / len(losses)) if losses else None,
        "largest_loss": r2(min(losses)) if losses else None,
        "expectancy": r2(sum(t["pnl"] for t in closed) / n) if n else None,
        "avg_hold_hours": r2(sum(holds) / n) if n else None,
        "longest_losing_streak": worst_streak,
        "total_costs": r2(sum(t.get("costs", 0) for t in closed)),
        "total_swap": r2(sum(t.get("swap", 0) for t in closed)),
    }
    return {"stats": stats, "equity": _downsample(curve), "trades": trades}
