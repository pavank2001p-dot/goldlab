"""Profile-fit verdicts: checks a backtest or the trade log against the limits of the user's
risk profile and suggests a trade size that would have stayed inside them.

This describes past results against self-chosen limits. It is not advice to trade."""

from fastapi import APIRouter, Depends, HTTPException, Query

from . import db
from .auth import UserOut, current_user
from .risk import PROFILES, profile_of
from .trades import log_report

router = APIRouter(prefix="/fit", tags=["fit"])

# Within this multiple of a limit counts as "close"; beyond it, "over".
CLOSE = 1.25
LABELS = {"fits": "Fits your profile", "close": "Slightly outside your profile", "over": "Outside your profile"}


def _level(value: float | None, limit: float) -> str:
    if value is None or value <= limit:
        return "fits"
    return "close" if value <= limit * CLOSE else "over"


def assess(trades: list[dict], stats: dict, capital: float, profile: str, stop_loss_pct: float | None = None) -> dict:
    """trades: report trades in time order (side, units, entry_price, pnl, optional stop_loss).
    stop_loss_pct: the backtest's stop distance, if it used one (overrides per-trade stops)."""
    limits = PROFILES[profile]
    closed = [t for t in trades if t.get("exit_time") is not None]

    # Equity before each trade, from the starting capital plus earlier results.
    equity, before = capital, []
    for t in closed:
        before.append(equity)
        equity += t["pnl"]

    planned, leverage, loss_pct, unprotected = [], [], [], 0
    for t, eq in zip(closed, before):
        if eq <= 0:
            continue
        price, units = t["entry_price"], t["units"]
        leverage.append(units * price / eq)
        loss_pct.append(max(-t["pnl"], 0) / eq * 100)
        if stop_loss_pct:
            planned.append(units * price * stop_loss_pct / 100 / eq * 100)
        elif t.get("stop_loss"):
            planned.append(units * abs(price - t["stop_loss"]) / eq * 100)
        else:
            unprotected += 1

    r2 = lambda x: None if x is None else round(x, 2)  # noqa: E731
    max_lev = max(leverage, default=None)
    max_dd = abs(stats.get("max_drawdown_pct") or 0)
    worst_loss = max(loss_pct, default=None)
    max_planned = max(planned, default=None)
    # Without a stop, the biggest realised loss is the best evidence of risk taken per trade.
    risk_value = max_planned if planned and not unprotected else max(filter(None, [max_planned, worst_loss]), default=None)

    checks = [
        {
            "key": "drawdown",
            "label": "Largest fall from a peak",
            "value": r2(max_dd),
            "limit": limits["max_drawdown_pct"],
            "unit": "%",
            "level": _level(max_dd, limits["max_drawdown_pct"]),
        },
        {
            "key": "risk_per_trade",
            "label": "Risk per trade" if not unprotected else "Risk per trade (largest loss, some trades had no stop)",
            "value": r2(risk_value),
            "limit": limits["max_risk_per_trade_pct"],
            "unit": "%",
            "level": _level(risk_value, limits["max_risk_per_trade_pct"]),
        },
        {
            "key": "leverage",
            "label": "Largest position compared with the account",
            "value": r2(max_lev),
            "limit": limits["max_leverage"],
            "unit": "x",
            "level": _level(max_lev, limits["max_leverage"]),
        },
    ]
    order = ["fits", "close", "over"]
    verdict = max((c["level"] for c in checks), key=order.index) if closed else "fits"

    notes = []
    if unprotected:
        notes.append(f"{unprotected} of {len(closed)} trades had no stop loss, so a single bad move had no planned limit.")
    if stats.get("wiped_out"):
        verdict = "over"
        notes.append("The account ran out of money, which is outside every profile.")

    # Drawdown, leverage and per-trade risk all scale roughly with trade size, so the
    # tightest ratio gives a size that would have stayed inside every limit.
    units = max((t["units"] for t in closed), default=None)
    suggested = None
    if units and verdict != "fits":
        ratios = [c["limit"] / c["value"] for c in checks if c["value"]]
        if ratios:
            suggested = max(int(units * min(ratios) * 10) / 10, 0.1)
            if suggested >= units:
                suggested = None

    return {
        "profile": profile,
        "profile_label": limits["label"],
        "verdict": verdict,
        "verdict_label": LABELS[verdict],
        "checks": checks,
        "notes": notes,
        "trades_checked": len(closed),
        "units": units,
        "suggested_units": suggested,
    }


def _profile(user_id: int) -> str:
    p = profile_of(user_id)
    if not p:
        raise HTTPException(404, "Take the risk quiz first")
    return p["profile"]


def for_backtest(user_id: int, bid: int) -> dict:
    profile = _profile(user_id)
    with db.conn() as c:
        row = c.execute("SELECT params, result FROM backtests WHERE id = %s AND user_id = %s", (bid, user_id)).fetchone()
    if not row:
        raise HTTPException(404, "Backtest not found")
    p, rep = row["params"], row["result"]
    return assess(rep["trades"], rep["stats"], p["capital"], profile, p.get("stop_loss_pct"))


def for_trade_log(user_id: int, capital: float) -> dict:
    profile = _profile(user_id)
    rep = log_report(user_id, capital)
    return assess(rep["trades"], rep["stats"], capital, profile)


@router.get("/backtests/{bid}")
def backtest_fit(bid: int, user: UserOut = Depends(current_user)):
    return for_backtest(user.id, bid)


@router.get("/trades")
def trades_fit(capital: float = Query(10_000, gt=0, le=100_000_000), user: UserOut = Depends(current_user)):
    return for_trade_log(user.id, capital)
