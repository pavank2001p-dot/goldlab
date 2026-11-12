"""The disciplined twin: every closed paper trade taken again by a copy of the user that keeps the rules.

The twin enters at the same price and time as the user and exits when the user did, unless a rule says
otherwise. Its rules match the coach's mistake tags:
- Revenge trade, or opened near a high-impact release: the twin doesn't take it.
- Stop moved away: the twin keeps the stop as it was first planned.
- No stop: the twin uses a stop that would lose exactly the risk limit at the user's size.
- Oversized: the twin sizes the trade so its stop risks the limit.
A twin stop is checked against minute bars (hourly where minutes aren't kept) between the entry and the user's
exit; when it is touched the twin is out at the stop. Spread, slippage and swap are left out of the twin's
changes, so the gap is about decisions. The difference between the two results is the cost of breaking rules,
split by the habit that caused it.

Session glyphs: a small per-day summary of the same trades (count, result, rules broken) that the page draws as
an emblem.

Grades process only and never says where prices will go."""

from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends

from . import db
from .auth import UserOut, current_user
from .coach import TAGS, _limit, tag_trades

router = APIRouter(prefix="/coach", tags=["coach"])

MAX_BARS = 50_000
SKIP = ("revenge", "red_folder")


def stop_hit(side: str, stop: float, bars: list[dict]) -> bool:
    """Whether any bar reached the stop."""
    if side == "long":
        return any(b["low"] <= stop for b in bars)
    return any(b["high"] >= stop for b in bars)


def replay(t: dict, bars: list[dict], limit_pct: float, equity: float) -> dict:
    """The twin's version of one trade: its pnl and how much of the gap each habit caused."""
    pnl = t["pnl"]
    if any(k in t["tags"] for k in SKIP):
        k = next(k for k in SKIP if k in t["tags"])
        return {"pnl": 0.0, "costs": {k: pnl - 0.0}, "rule": f"Skipped: {TAGS[k][0].lower()}"}
    sign = 1 if t["side"] == "long" else -1
    costs: dict[str, float] = {}
    rule = []
    stop = t["stop_loss"]
    twin = pnl
    planned = None
    if "stop_widened" in t["tags"] and t.get("planned_stop") is not None:
        planned, tag = t["planned_stop"], "stop_widened"
    elif "no_stop" in t["tags"] or ("stop_widened" in t["tags"] and stop is None):
        planned = t["entry_price"] - sign * (equity * limit_pct / 100) / t["units"] if t["units"] > 0 and equity > 0 else None
        tag = "no_stop" if "no_stop" in t["tags"] else "stop_widened"
    if planned is not None:
        stop = planned
        if stop_hit(t["side"], planned, bars):
            twin = sign * (planned - t["entry_price"]) * t["units"]
            rule.append("Kept the planned stop and was stopped out" if tag == "stop_widened" else "Used a stop at the limit and was stopped out")
        else:
            rule.append("Kept the planned stop" if tag == "stop_widened" else "Used a stop at the limit")
        costs[tag] = pnl - twin
    if stop is not None and equity > 0 and t["units"] > 0:
        risk_pct = abs(t["entry_price"] - stop) * t["units"] / equity * 100
        if risk_pct > limit_pct * 1.05:
            scaled = twin * limit_pct / risk_pct
            costs["oversized"] = twin - scaled
            twin = scaled
            rule.append(f"Sized to your {limit_pct:g}% limit")
    return {"pnl": round(twin, 2), "costs": {k: round(v, 2) for k, v in costs.items()},
            "rule": "; ".join(rule) or "Same trade"}


def days(trades: list[dict]) -> list[dict]:
    """Per UTC day: trades, result, wins and how many broke at least one rule."""
    by = defaultdict(lambda: {"trades": 0, "pnl": 0.0, "wins": 0, "broken": 0})
    for t in trades:
        d = by[t["opened_at"].date().isoformat()]
        d["trades"] += 1
        d["pnl"] += t["pnl"]
        d["wins"] += t["pnl"] > 0
        d["broken"] += bool(t["tags"])
    return [{"day": k, **v, "pnl": round(v["pnl"], 2)} for k, v in sorted(by.items())]


def _bars(c, symbol: str, start: datetime, end: datetime) -> list[dict]:
    for tf in ("1m", "1h"):
        rows = c.execute("SELECT high, low FROM candles WHERE symbol = %s AND tf = %s AND ts >= %s AND ts <= %s "
                         "ORDER BY ts LIMIT %s", (symbol, tf, start - timedelta(hours=1) if tf == "1h" else start,
                                                  end, MAX_BARS)).fetchall()
        if rows:
            return rows
    return []


def twin(user_id: int) -> dict:
    with db.conn() as c:
        trades = tag_trades(c, user_id)
        if not trades:
            return {"trades": [], "curve": [], "you": 0.0, "twin": 0.0, "costs": [], "days": [],
                    "limit_pct": _limit(user_id)}
        extra = {r["id"]: r for r in c.execute(
            "SELECT id, units, entry_price, stop_loss, planned_stop FROM paper_positions WHERE user_id = %s "
            "AND closed_at IS NOT NULL", (user_id,)).fetchall()}
        acct = c.execute("SELECT starting_balance FROM paper_accounts WHERE user_id = %s", (user_id,)).fetchone()
        start = acct["starting_balance"] if acct else 10_000.0
        limit = _limit(user_id)
        you = tw = 0.0
        curve, out = [], []
        cost = defaultdict(lambda: {"cost": 0.0, "trades": 0})
        for t in sorted(trades, key=lambda x: x["closed_at"]):
            t = {**t, **extra.get(t["id"], {})}
            needs_bars = any(k in t["tags"] for k in ("stop_widened", "no_stop")) and not any(k in t["tags"] for k in SKIP)
            bars = _bars(c, t["symbol"], t["opened_at"], t["closed_at"]) if needs_bars else []
            r = replay(t, bars, limit, start + you)
            you += t["pnl"]
            tw += r["pnl"]
            for k, v in r["costs"].items():
                cost[k]["cost"] += v
                cost[k]["trades"] += 1
            curve.append({"t": int(t["closed_at"].timestamp()), "you": round(you, 2), "twin": round(tw, 2)})
            out.append({"id": t["id"], "symbol": t["symbol"], "side": t["side"], "closed_at": t["closed_at"],
                        "pnl": t["pnl"], "twin_pnl": r["pnl"], "rule": r["rule"], "tags": t["tags"]})
    costs = sorted(({"tag": k, "label": TAGS[k][0], "cost": round(v["cost"], 2), "trades": v["trades"]}
                    for k, v in cost.items() if abs(v["cost"]) >= 0.01), key=lambda x: -x["cost"])
    return {"trades": out[::-1], "curve": curve, "you": round(you, 2), "twin": round(tw, 2), "costs": costs,
            "days": days(trades), "limit_pct": limit}


@router.get("/twin")
def get_twin(user: UserOut = Depends(current_user)):
    """Your closed paper trades next to a twin that kept your rules, and what each broken rule cost."""
    return twin(user.id)
