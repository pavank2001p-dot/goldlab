"""Strategy backtests on stored XAU/USD bars.

Signals are computed on each bar's close and filled at the next bar's open, so a
strategy never trades on information it could not have had. Stored prices are bids:
longs buy at bid + spread and sell at bid; shorts sell at bid and buy back at bid + spread.
"""

import math
from collections import deque
from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, model_validator

from . import config, db
from .auth import UserOut, current_user
from .report import build_report, trading_date

router = APIRouter(prefix="/backtests", tags=["backtests"])

# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

STRATEGIES = {
    "ma_cross": {
        "label": "Moving-average crossover",
        "summary": "Long when the fast average is above the slow one, short when it is below. A trend follower.",
        "params": [
            {"key": "fast", "label": "Fast average (bars)", "default": 20, "min": 2, "max": 200, "step": 1},
            {"key": "slow", "label": "Slow average (bars)", "default": 50, "min": 5, "max": 400, "step": 1},
            {"key": "ema", "label": "Use exponential averages (1 = yes)", "default": 0, "min": 0, "max": 1, "step": 1},
        ],
    },
    "breakout": {
        "label": "Channel breakout",
        "summary": "Buys a close above the highest high of the last N bars, sells a close below the lowest low. "
        "Exits when price breaks the shorter opposite channel.",
        "params": [
            {"key": "entry", "label": "Entry channel (bars)", "default": 20, "min": 5, "max": 200, "step": 1},
            {"key": "exit", "label": "Exit channel (bars)", "default": 10, "min": 2, "max": 200, "step": 1},
        ],
    },
    "rsi_reversion": {
        "label": "RSI mean reversion",
        "summary": "Buys when RSI is oversold and sells when it is overbought, exiting as RSI returns to 50.",
        "params": [
            {"key": "period", "label": "RSI period (bars)", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "lower", "label": "Oversold level", "default": 30, "min": 5, "max": 50, "step": 1},
            {"key": "upper", "label": "Overbought level", "default": 70, "min": 50, "max": 95, "step": 1},
        ],
    },
    "bollinger": {
        "label": "Bollinger band reversion",
        "summary": "Buys a close below the lower band and sells a close above the upper band, "
        "exiting at the middle band.",
        "params": [
            {"key": "period", "label": "Band period (bars)", "default": 20, "min": 5, "max": 200, "step": 1},
            {"key": "width", "label": "Band width (standard deviations)", "default": 2, "min": 0.5, "max": 4, "step": 0.1},
        ],
    },
}


def _sma(xs: list[float], n: int) -> list[float | None]:
    out, s = [], 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= n:
            s -= xs[i - n]
        out.append(s / n if i >= n - 1 else None)
    return out


def _ema(xs: list[float], n: int) -> list[float | None]:
    out: list[float | None] = []
    k, e = 2 / (n + 1), None
    for i, x in enumerate(xs):
        if i == n - 1:
            e = sum(xs[:n]) / n
        elif e is not None:
            e = x * k + e * (1 - k)
        out.append(e)
    return out


def _rsi(xs: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(xs)
    gain = loss = 0.0
    for i in range(1, len(xs)):
        d = xs[i] - xs[i - 1]
        g, l = max(d, 0.0), max(-d, 0.0)
        if i <= n:
            gain += g / n
            loss += l / n
            if i < n:
                continue
        else:  # Wilder smoothing
            gain = (gain * (n - 1) + g) / n
            loss = (loss * (n - 1) + l) / n
        out[i] = 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    return out


def _rolling(xs: list[float], n: int, fn) -> list[float | None]:
    win: deque = deque(maxlen=n)
    out = []
    for x in xs:
        out.append(fn(win) if len(win) == n else None)  # uses the previous n values only
        win.append(x)
    return out


def signals(strategy: str, p: dict, bars: list[dict]) -> list[int]:
    """Desired position after each bar's close: 1 long, -1 short, 0 flat."""
    c = [b["c"] for b in bars]
    pos, out = 0, []
    if strategy == "ma_cross":
        avg = _ema if p["ema"] else _sma
        f, s = avg(c, int(p["fast"])), avg(c, int(p["slow"]))
        for a, b in zip(f, s):
            if a is not None and b is not None and a != b:
                pos = 1 if a > b else -1
            out.append(pos)
        return out
    if strategy == "breakout":
        hi_e = _rolling([b["h"] for b in bars], int(p["entry"]), max)
        lo_e = _rolling([b["l"] for b in bars], int(p["entry"]), min)
        hi_x = _rolling([b["h"] for b in bars], int(p["exit"]), max)
        lo_x = _rolling([b["l"] for b in bars], int(p["exit"]), min)
        for i, x in enumerate(c):
            if hi_e[i] is None:
                out.append(0)
                continue
            if pos == 1 and lo_x[i] is not None and x < lo_x[i]:
                pos = 0
            elif pos == -1 and hi_x[i] is not None and x > hi_x[i]:
                pos = 0
            if x > hi_e[i]:
                pos = 1
            elif x < lo_e[i]:
                pos = -1
            out.append(pos)
        return out
    if strategy == "rsi_reversion":
        r = _rsi(c, int(p["period"]))
        for v in r:
            if v is None:
                out.append(0)
                continue
            if pos == 1 and v >= 50 or pos == -1 and v <= 50:
                pos = 0
            if v < p["lower"]:
                pos = 1
            elif v > p["upper"]:
                pos = -1
            out.append(pos)
        return out
    if strategy == "bollinger":
        n = int(p["period"])
        mid = _sma(c, n)
        for i, x in enumerate(c):
            if mid[i] is None:
                out.append(0)
                continue
            m = mid[i]
            sd = math.sqrt(sum((y - m) ** 2 for y in c[i - n + 1 : i + 1]) / n)
            up, lo = m + p["width"] * sd, m - p["width"] * sd
            if pos == 1 and x >= m or pos == -1 and x <= m:
                pos = 0
            if x < lo:
                pos = 1
            elif x > up:
                pos = -1
            out.append(pos)
        return out
    raise ValueError(f"unknown strategy {strategy}")


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class BacktestIn(BaseModel):
    strategy: Literal["ma_cross", "breakout", "rsi_reversion", "bollinger"]
    params: dict[str, float] = {}
    tf: Literal["1h", "1d"] = "1d"
    start: date = date(2015, 1, 1)
    end: date | None = None
    direction: Literal["both", "long_only", "short_only"] = "both"
    capital: float = Field(10_000, gt=0, le=100_000_000)
    units: float = Field(5, gt=0, le=100_000, description="Ounces per trade (1 standard lot = 100 oz)")
    spread: float = Field(0.30, ge=0, le=20, description="USD per ounce, paid once per round trip")
    swap_long: float = Field(-0.25, ge=-5, le=5, description="USD per ounce per night held long (negative = cost)")
    swap_short: float = Field(0.05, ge=-5, le=5, description="USD per ounce per night held short")
    stop_loss_pct: float | None = Field(None, gt=0, le=50)
    take_profit_pct: float | None = Field(None, gt=0, le=200)

    @model_validator(mode="after")
    def _check(self):
        spec = {d["key"]: d for d in STRATEGIES[self.strategy]["params"]}
        unknown = set(self.params) - set(spec)
        if unknown:
            raise ValueError(f"Unknown settings for this strategy: {', '.join(sorted(unknown))}")
        full = {k: self.params.get(k, d["default"]) for k, d in spec.items()}
        for k, v in full.items():
            if not spec[k]["min"] <= v <= spec[k]["max"]:
                raise ValueError(f"{spec[k]['label']} must be between {spec[k]['min']} and {spec[k]['max']}")
        if self.strategy == "ma_cross" and full["fast"] >= full["slow"]:
            raise ValueError("The fast average must be shorter than the slow average")
        if self.strategy == "rsi_reversion" and full["lower"] >= full["upper"]:
            raise ValueError("The oversold level must be below the overbought level")
        if self.end and self.end <= self.start:
            raise ValueError("The end date must be after the start date")
        self.params = full
        return self


def run(cfg: BacktestIn, bars: list[dict]) -> dict:
    if len(bars) < 2:
        raise ValueError("Not enough price data in that date range")
    target = signals(cfg.strategy, cfg.params, bars)
    allow = {"both": (1, -1), "long_only": (1,), "short_only": (-1,)}[cfg.direction]
    sp, u = cfg.spread, cfg.units

    cash = cfg.capital
    pos = 0  # 1 long, -1 short
    entry = entry_t = 0.0
    swap_acc = 0.0
    blocked = 0  # side stopped out; wait for the signal to change before re-entering
    trades: list[dict] = []
    equity: list[tuple[int, float]] = [(bars[0]["t"], cash)]
    in_market = 0
    wiped_out = False

    def close(t: int, bid: float, reason: str):
        nonlocal cash, pos, swap_acc
        exit_px = bid if pos == 1 else bid + sp
        gross = (exit_px - entry) * u * pos
        pnl = gross + swap_acc
        cash += pnl
        trades.append({
            "side": "long" if pos == 1 else "short",
            "units": u,
            "entry_time": int(entry_t),
            "entry_price": round(entry, 3),
            "exit_time": t,
            "exit_price": round(exit_px, 3),
            "costs": round(sp * u, 2),
            "swap": round(swap_acc, 2),
            "pnl": round(pnl, 2),
            "exit_reason": reason,
        })
        pos, swap_acc = 0, 0.0

    def open_(t: int, bid: float, side: int):
        nonlocal pos, entry, entry_t
        pos, entry, entry_t = side, (bid + sp if side == 1 else bid), t

    for i in range(1, len(bars)):
        b, prev = bars[i], bars[i - 1]
        # Overnight financing for each trading-day rollover the position was held through.
        if pos:
            nights = (trading_date(b["t"]) - trading_date(prev["t"])).days
            if nights > 0:
                swap_acc += nights * u * (cfg.swap_long if pos == 1 else cfg.swap_short)

        want = target[i - 1] if target[i - 1] in allow else 0
        if blocked and want != blocked:
            blocked = 0
        if blocked:
            want = 0
        if pos != want:
            if pos:
                close(b["t"], b["o"], "signal")
            if want:
                open_(b["t"], b["o"], want)

        # Stop-loss / take-profit inside the bar; if both could trigger, assume the stop hit first.
        if pos and (cfg.stop_loss_pct or cfg.take_profit_pct):
            side = pos
            if pos == 1:
                stop = entry * (1 - cfg.stop_loss_pct / 100) if cfg.stop_loss_pct else None
                take = entry * (1 + cfg.take_profit_pct / 100) if cfg.take_profit_pct else None
                if stop is not None and b["l"] <= stop:
                    close(b["t"], min(b["o"], stop), "stop_loss")
                elif take is not None and b["h"] >= take:
                    close(b["t"], max(b["o"], take), "take_profit")
            else:  # short exits buy at the ask, i.e. bid + spread
                stop = entry * (1 + cfg.stop_loss_pct / 100) if cfg.stop_loss_pct else None
                take = entry * (1 - cfg.take_profit_pct / 100) if cfg.take_profit_pct else None
                if stop is not None and b["h"] + sp >= stop:
                    close(b["t"], max(b["o"] + sp, stop) - sp, "stop_loss")
                elif take is not None and b["l"] + sp <= take:
                    close(b["t"], min(b["o"] + sp, take) - sp, "take_profit")
            if not pos:
                blocked = side

        if pos:
            in_market += 1
            mark = b["c"] if pos == 1 else b["c"] + sp
            equity.append((b["t"], cash + (mark - entry) * u * pos + swap_acc))
        else:
            equity.append((b["t"], cash))

        # A real account is closed out long before it goes negative; stop the test at zero.
        if equity[-1][1] <= 0:
            if pos:
                close(b["t"], b["c"], "account_wiped_out")
                equity[-1] = (b["t"], cash)
            wiped_out = True
            break

    if pos:
        close(bars[-1]["t"], bars[-1]["c"], "end_of_test")
        equity[-1] = (bars[-1]["t"], cash)

    rep = build_report(trades, equity, cfg.capital)
    first, last = bars[0]["c"], bars[-1]["c"]
    rep["stats"]["buy_and_hold_pct"] = round((last / first - 1) * 100, 2)
    rep["stats"]["time_in_market_pct"] = round(in_market / (len(bars) - 1) * 100, 2)
    rep["stats"]["bars"] = len(bars)
    rep["stats"]["wiped_out"] = wiped_out
    rep["period"] = {"start": bars[0]["t"], "end": bars[-1]["t"]}
    return rep


def load_bars(tf: str, start: date, end: date | None) -> list[dict]:
    s = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    sql = "SELECT extract(epoch FROM ts)::bigint AS t, open AS o, high AS h, low AS l, close AS c FROM candles WHERE symbol = %s AND tf = %s AND ts >= %s"
    args: list = [config.SYMBOL, tf, s]
    if end:
        sql += " AND ts < %s"
        args.append(datetime(end.year, end.month, end.day, tzinfo=timezone.utc))
    with db.conn() as c:
        return c.execute(sql + " ORDER BY ts", args).fetchall()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@router.get("/strategies")
def strategies():
    return [{"key": k, **v} for k, v in STRATEGIES.items()]


@router.post("", status_code=201)
def create(cfg: BacktestIn, user: UserOut = Depends(current_user)):
    try:
        rep = run(cfg, load_bars(cfg.tf, cfg.start, cfg.end))
    except ValueError as e:
        raise HTTPException(422, str(e))
    params = cfg.model_dump(mode="json")
    with db.conn() as c:
        row = c.execute(
            "INSERT INTO backtests (user_id, params, stats, result) VALUES (%s, %s, %s, %s) RETURNING id, created_at",
            (user.id, Jsonb(params), Jsonb(rep["stats"]), Jsonb(rep)),
        ).fetchone()
    return {"id": row["id"], "created_at": row["created_at"], "params": params, **rep}


@router.get("")
def list_(user: UserOut = Depends(current_user)):
    with db.conn() as c:
        return c.execute(
            "SELECT id, created_at, params, stats FROM backtests WHERE user_id = %s ORDER BY created_at DESC LIMIT 100",
            (user.id,),
        ).fetchall()


@router.get("/{bid}")
def get(bid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        row = c.execute(
            "SELECT id, created_at, params, result FROM backtests WHERE id = %s AND user_id = %s", (bid, user.id)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Backtest not found")
    return {"id": row["id"], "created_at": row["created_at"], "params": row["params"], **row["result"]}


@router.delete("/{bid}", status_code=204)
def delete(bid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        c.execute("DELETE FROM backtests WHERE id = %s AND user_id = %s", (bid, user.id))
