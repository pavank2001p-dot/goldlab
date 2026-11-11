"""Strategy backtests on stored bars of any market in app.instruments (gold by default).

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
from . import instruments as ins
from .auth import UserOut, current_user
from .custom import Rules
from .custom import signals as custom_signals
from .report import build_report, trading_date

router = APIRouter(prefix="/backtests", tags=["backtests"])

# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

STRATEGIES = {
    "ma_cross": {
        "label": "Moving-average crossover",
        "kind": "trend",
        "summary": "Long when the fast average is above the slow one, short when it is below. A trend follower.",
        "params": [
            {"key": "fast", "label": "Fast average (bars)", "default": 20, "min": 2, "max": 200, "step": 1},
            {"key": "slow", "label": "Slow average (bars)", "default": 50, "min": 5, "max": 400, "step": 1},
            {"key": "ema", "label": "Use exponential averages (1 = yes)", "default": 0, "min": 0, "max": 1, "step": 1},
        ],
    },
    "breakout": {
        "label": "Channel breakout (Donchian)",
        "kind": "trend",
        "summary": "Buys a close above the highest high of the last N bars, sells a close below the lowest low. "
        "Exits when price breaks the shorter opposite channel.",
        "params": [
            {"key": "entry", "label": "Entry channel (bars)", "default": 20, "min": 5, "max": 200, "step": 1},
            {"key": "exit", "label": "Exit channel (bars)", "default": 10, "min": 2, "max": 200, "step": 1},
        ],
    },
    "ma_trend": {
        "label": "Price vs moving average",
        "kind": "trend",
        "summary": "Long while the close is above one moving average, short while it is below. "
        "The classic 200-day trend filter.",
        "params": [
            {"key": "period", "label": "Average length (bars)", "default": 200, "min": 2, "max": 400, "step": 1},
            {"key": "ema", "label": "Use an exponential average (1 = yes)", "default": 0, "min": 0, "max": 1, "step": 1},
        ],
    },
    "macd": {
        "label": "MACD crossover",
        "kind": "trend",
        "summary": "Long when the MACD line is above its signal line, short when it is below. "
        "MACD is the gap between a fast and a slow exponential average.",
        "params": [
            {"key": "fast", "label": "Fast average (bars)", "default": 12, "min": 2, "max": 100, "step": 1},
            {"key": "slow", "label": "Slow average (bars)", "default": 26, "min": 5, "max": 200, "step": 1},
            {"key": "signal", "label": "Signal line (bars)", "default": 9, "min": 2, "max": 50, "step": 1},
        ],
    },
    "supertrend": {
        "label": "Supertrend",
        "kind": "trend",
        "summary": "Follows a trailing line set a few ATRs (average true ranges) from price. "
        "Flips long or short when the close crosses it, so it is always in the market.",
        "params": [
            {"key": "period", "label": "ATR period (bars)", "default": 10, "min": 2, "max": 100, "step": 1},
            {"key": "mult", "label": "ATR multiple", "default": 3, "min": 0.5, "max": 10, "step": 0.1},
        ],
    },
    "parabolic_sar": {
        "label": "Parabolic SAR",
        "kind": "trend",
        "summary": "A stop that trails price and speeds up as the trend extends. "
        "When price touches it the position reverses.",
        "params": [
            {"key": "step", "label": "Acceleration step", "default": 0.02, "min": 0.005, "max": 0.2, "step": 0.005},
            {"key": "max_af", "label": "Maximum acceleration", "default": 0.2, "min": 0.05, "max": 1, "step": 0.01},
        ],
    },
    "adx_trend": {
        "label": "ADX trend strength",
        "kind": "trend",
        "summary": "Trades only when ADX says a trend is strong, in the direction of the stronger "
        "directional line (+DI or -DI). Flat when the trend fades.",
        "params": [
            {"key": "period", "label": "ADX period (bars)", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "threshold", "label": "Minimum ADX to trade", "default": 25, "min": 5, "max": 60, "step": 1},
        ],
    },
    "keltner": {
        "label": "Keltner channel breakout",
        "kind": "trend",
        "summary": "Buys a close above the upper Keltner band and sells a close below the lower one, "
        "exiting when price returns to the middle average.",
        "params": [
            {"key": "period", "label": "Middle average (bars)", "default": 20, "min": 5, "max": 200, "step": 1},
            {"key": "atr", "label": "ATR period (bars)", "default": 10, "min": 2, "max": 100, "step": 1},
            {"key": "mult", "label": "Band width (ATRs)", "default": 2, "min": 0.5, "max": 6, "step": 0.1},
        ],
    },
    "momentum": {
        "label": "Momentum (rate of change)",
        "kind": "trend",
        "summary": "Long when price is up more than the threshold over the lookback, short when it is down "
        "more than the threshold, flat in between.",
        "params": [
            {"key": "lookback", "label": "Lookback (bars)", "default": 60, "min": 2, "max": 400, "step": 1},
            {"key": "threshold", "label": "Threshold (%)", "default": 0, "min": 0, "max": 50, "step": 0.1},
        ],
    },
    "rsi_reversion": {
        "label": "RSI mean reversion",
        "kind": "reversion",
        "summary": "Buys when RSI is oversold and sells when it is overbought, exiting as RSI returns to 50.",
        "params": [
            {"key": "period", "label": "RSI period (bars)", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "lower", "label": "Oversold level", "default": 30, "min": 5, "max": 50, "step": 1},
            {"key": "upper", "label": "Overbought level", "default": 70, "min": 50, "max": 95, "step": 1},
        ],
    },
    "bollinger": {
        "label": "Bollinger band reversion",
        "kind": "reversion",
        "summary": "Buys a close below the lower band and sells a close above the upper band, "
        "exiting at the middle band.",
        "params": [
            {"key": "period", "label": "Band period (bars)", "default": 20, "min": 5, "max": 200, "step": 1},
            {"key": "width", "label": "Band width (standard deviations)", "default": 2, "min": 0.5, "max": 4, "step": 0.1},
        ],
    },
    "stochastic": {
        "label": "Stochastic oscillator reversion",
        "kind": "reversion",
        "summary": "Buys when the stochastic %K is oversold and sells when it is overbought, "
        "exiting as it returns to 50. %K shows where the close sits in the recent high-low range.",
        "params": [
            {"key": "period", "label": "Range period (bars)", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "smooth", "label": "Smoothing (bars)", "default": 3, "min": 1, "max": 20, "step": 1},
            {"key": "lower", "label": "Oversold level", "default": 20, "min": 1, "max": 50, "step": 1},
            {"key": "upper", "label": "Overbought level", "default": 80, "min": 50, "max": 99, "step": 1},
        ],
    },
    "cci": {
        "label": "CCI reversion",
        "kind": "reversion",
        "summary": "Buys when the Commodity Channel Index drops below minus the level and sells when it rises "
        "above it, exiting as CCI crosses zero.",
        "params": [
            {"key": "period", "label": "CCI period (bars)", "default": 20, "min": 5, "max": 200, "step": 1},
            {"key": "level", "label": "Extreme level", "default": 100, "min": 50, "max": 300, "step": 5},
        ],
    },
    "williams_r": {
        "label": "Williams %R reversion",
        "kind": "reversion",
        "summary": "Buys when Williams %R is below the oversold level and sells when it is above the overbought "
        "level, exiting at the midpoint (-50).",
        "params": [
            {"key": "period", "label": "Range period (bars)", "default": 14, "min": 2, "max": 100, "step": 1},
            {"key": "lower", "label": "Oversold level", "default": -80, "min": -99, "max": -50, "step": 1},
            {"key": "upper", "label": "Overbought level", "default": -20, "min": -50, "max": -1, "step": 1},
        ],
    },
    "ichimoku": {
        "label": "Ichimoku cloud",
        "kind": "trend",
        "summary": "Long when the close is above the cloud and the conversion line is above the base line, short "
        "in the mirror case, flat once price falls back into the cloud.",
        "params": [
            {"key": "tenkan", "label": "Conversion line (bars)", "default": 9, "min": 2, "max": 100, "step": 1},
            {"key": "kijun", "label": "Base line (bars)", "default": 26, "min": 5, "max": 200, "step": 1},
            {"key": "senkou", "label": "Leading span B (bars)", "default": 52, "min": 10, "max": 300, "step": 1},
        ],
    },
    "triple_ma": {
        "label": "Triple moving average",
        "kind": "trend",
        "summary": "Long when the fast, middle and slow exponential averages are stacked upward, short when they are "
        "stacked downward, flat when they are mixed.",
        "params": [
            {"key": "fast", "label": "Fast average (bars)", "default": 10, "min": 2, "max": 100, "step": 1},
            {"key": "mid", "label": "Middle average (bars)", "default": 20, "min": 3, "max": 200, "step": 1},
            {"key": "slow", "label": "Slow average (bars)", "default": 50, "min": 5, "max": 400, "step": 1},
        ],
    },
    "heikin_ashi": {
        "label": "Heikin-Ashi trend",
        "kind": "trend",
        "summary": "Smooths candles the Heikin-Ashi way and follows them: long after a run of rising candles, "
        "short after a run of falling ones.",
        "params": [
            {"key": "confirm", "label": "Candles in a row to enter", "default": 2, "min": 1, "max": 10, "step": 1},
        ],
    },
    "aroon": {
        "label": "Aroon trend",
        "kind": "trend",
        "summary": "Aroon measures how recently the highest high and lowest low were set. Long when Aroon Up is "
        "strong and above Aroon Down, short in the mirror case.",
        "params": [
            {"key": "period", "label": "Aroon period (bars)", "default": 25, "min": 5, "max": 200, "step": 1},
            {"key": "threshold", "label": "Strong level", "default": 70, "min": 50, "max": 100, "step": 5},
        ],
    },
    "squeeze": {
        "label": "Bollinger squeeze breakout",
        "kind": "trend",
        "summary": "Waits for the Bollinger bands to narrow to their tightest in a while, then trades the breakout "
        "beyond a band and exits at the middle band.",
        "params": [
            {"key": "period", "label": "Band period (bars)", "default": 20, "min": 5, "max": 200, "step": 1},
            {"key": "width", "label": "Band width (std devs)", "default": 2, "min": 1, "max": 4, "step": 0.5},
            {"key": "lookback", "label": "Squeeze lookback (bars)", "default": 100, "min": 20, "max": 500, "step": 1},
        ],
    },
    "inside_bar": {
        "label": "Inside-bar breakout",
        "kind": "trend",
        "summary": "After a candle that sits inside the one before it, trades a close beyond that earlier candle's "
        "high or low, and exits after a set number of bars or on the opposite breakout.",
        "params": [
            {"key": "hold", "label": "Bars to hold", "default": 10, "min": 1, "max": 100, "step": 1},
        ],
    },
    "rsi2_pullback": {
        "label": "RSI(2) pullback",
        "kind": "reversion",
        "summary": "A short-term dip buyer in the direction of the long trend: buys when 2-bar RSI is very low while "
        "price is above its long average, and exits when the close gets back above a short average.",
        "params": [
            {"key": "period", "label": "RSI period (bars)", "default": 2, "min": 2, "max": 10, "step": 1},
            {"key": "level", "label": "Oversold level", "default": 10, "min": 1, "max": 40, "step": 1},
            {"key": "trend", "label": "Trend average (bars)", "default": 200, "min": 20, "max": 400, "step": 1},
        ],
    },
    "fib_pullback": {
        "label": "Fibonacci pullback",
        "kind": "reversion",
        "summary": "In an uptrend, buys when price pulls back to a Fibonacci level of the recent swing and exits at "
        "the swing high or if the swing low breaks. The mirror for downtrends.",
        "params": [
            {"key": "lookback", "label": "Swing lookback (bars)", "default": 50, "min": 10, "max": 300, "step": 1},
            {"key": "level", "label": "Retracement level (%)", "default": 61.8, "min": 23.6, "max": 78.6, "step": 0.1},
            {"key": "trend", "label": "Trend average (bars)", "default": 200, "min": 20, "max": 400, "step": 1},
        ],
    },
    "buy_and_hold": {
        "label": "Buy and hold",
        "kind": "benchmark",
        "summary": "Buys on the first bar and holds to the end. A yardstick for every other strategy, "
        "with the same costs and position size.",
        "params": [],
    },
}

KINDS = {"trend": "Trend following", "reversion": "Mean reversion", "benchmark": "Benchmark", "custom": "Custom"}


def kind_of(strategy: str) -> str:
    return STRATEGIES[strategy]["kind"] if strategy in STRATEGIES else "custom"


def label_of(strategy: str, rules: "Rules | None" = None) -> str:
    if strategy == "custom":
        return rules.name if rules else "Custom strategy"
    return STRATEGIES[strategy]["label"]


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


def _stdev(xs: list[float], n: int) -> list[float | None]:
    """Population standard deviation of the last n values (including the current one)."""
    out: list[float | None] = []
    for i in range(len(xs)):
        if i < n - 1:
            out.append(None)
            continue
        w = xs[i - n + 1 : i + 1]
        m = sum(w) / n
        out.append(math.sqrt(sum((y - m) ** 2 for y in w) / n))
    return out


def _ema_opt(xs: list[float | None], n: int) -> list[float | None]:
    """EMA of a series that starts with None values (e.g. another indicator)."""
    first = next((i for i, x in enumerate(xs) if x is not None), len(xs))
    tail = _ema([x for x in xs[first:]], n)  # type: ignore[misc]
    return [None] * first + tail


def _sma_opt(xs: list[float | None], n: int) -> list[float | None]:
    first = next((i for i, x in enumerate(xs) if x is not None), len(xs))
    return [None] * first + _sma([x for x in xs[first:]], n)  # type: ignore[misc]


def _true_range(bars: list[dict]) -> list[float]:
    tr = [bars[0]["h"] - bars[0]["l"]]
    for i in range(1, len(bars)):
        h, l, pc = bars[i]["h"], bars[i]["l"], bars[i - 1]["c"]
        tr.append(max(h - l, abs(h - pc), abs(l - pc)))
    return tr


def _wilder(xs: list[float], n: int, start: int = 0) -> list[float | None]:
    """Wilder's smoothing (an EMA with k = 1/n), seeded with the mean of the first n values from start."""
    out: list[float | None] = [None] * len(xs)
    if len(xs) < start + n:
        return out
    v = sum(xs[start : start + n]) / n
    out[start + n - 1] = v
    for i in range(start + n, len(xs)):
        v = (v * (n - 1) + xs[i]) / n
        out[i] = v
    return out


def _atr(bars: list[dict], n: int) -> list[float | None]:
    return _wilder(_true_range(bars), n)


def _range_position(bars: list[dict], n: int) -> list[float | None]:
    """Where each close sits in the high-low range of the last n bars (including it), 0 to 100."""
    out: list[float | None] = []
    for i, b in enumerate(bars):
        if i < n - 1:
            out.append(None)
            continue
        win = bars[i - n + 1 : i + 1]
        hh, ll = max(x["h"] for x in win), min(x["l"] for x in win)
        out.append(50.0 if hh == ll else (b["c"] - ll) / (hh - ll) * 100)
    return out


def _adx(bars: list[dict], n: int) -> tuple[list, list, list]:
    """ADX, +DI and -DI (Wilder)."""
    m = len(bars)
    pdm, mdm = [0.0] * m, [0.0] * m
    for i in range(1, m):
        up = bars[i]["h"] - bars[i - 1]["h"]
        down = bars[i - 1]["l"] - bars[i]["l"]
        pdm[i] = up if up > down and up > 0 else 0.0
        mdm[i] = down if down > up and down > 0 else 0.0
    tr = _true_range(bars)
    s_tr, s_p, s_m = _wilder(tr, n, 1), _wilder(pdm, n, 1), _wilder(mdm, n, 1)
    pdi: list[float | None] = [None] * m
    mdi: list[float | None] = [None] * m
    dx: list[float] = [0.0] * m
    first = None
    for i in range(m):
        if s_tr[i] is None:
            continue
        first = i if first is None else first
        pdi[i] = 0.0 if not s_tr[i] else 100 * s_p[i] / s_tr[i]
        mdi[i] = 0.0 if not s_tr[i] else 100 * s_m[i] / s_tr[i]
        tot = pdi[i] + mdi[i]
        dx[i] = 0.0 if tot == 0 else 100 * abs(pdi[i] - mdi[i]) / tot
    adx = _wilder(dx, n, first) if first is not None else [None] * m
    return adx, pdi, mdi


def _supertrend(bars: list[dict], n: int, mult: float) -> list[int]:
    atr = _atr(bars, n)
    out, trend = [], 0
    fub = flb = None
    for i, b in enumerate(bars):
        if atr[i] is None:
            out.append(0)
            continue
        hl2 = (b["h"] + b["l"]) / 2
        ub, lb = hl2 + mult * atr[i], hl2 - mult * atr[i]
        pc = bars[i - 1]["c"]
        fub = ub if fub is None or ub < fub or pc > fub else fub
        flb = lb if flb is None or lb > flb or pc < flb else flb
        if trend == 0:
            trend = 1 if b["c"] >= hl2 else -1
        elif trend == 1 and b["c"] < flb:
            trend = -1
        elif trend == -1 and b["c"] > fub:
            trend = 1
        out.append(trend)
    return out


def _psar(bars: list[dict], step: float, max_af: float) -> list[int]:
    if len(bars) < 3:
        return [0] * len(bars)
    up = bars[1]["c"] >= bars[0]["c"]
    sar = bars[0]["l"] if up else bars[0]["h"]
    ep = bars[1]["h"] if up else bars[1]["l"]
    af = step
    out = [0, 1 if up else -1]
    for i in range(2, len(bars)):
        b = bars[i]
        sar = sar + af * (ep - sar)
        if up:
            sar = min(sar, bars[i - 1]["l"], bars[i - 2]["l"])
            if b["l"] < sar:
                up, sar, ep, af = False, ep, b["l"], step
            elif b["h"] > ep:
                ep, af = b["h"], min(af + step, max_af)
        else:
            sar = max(sar, bars[i - 1]["h"], bars[i - 2]["h"])
            if b["h"] > sar:
                up, sar, ep, af = True, ep, b["h"], step
            elif b["l"] < ep:
                ep, af = b["l"], min(af + step, max_af)
        out.append(1 if up else -1)
    return out


def _cci(bars: list[dict], n: int) -> list[float | None]:
    tp = [(b["h"] + b["l"] + b["c"]) / 3 for b in bars]
    mid = _sma(tp, n)
    out: list[float | None] = []
    for i, m in enumerate(mid):
        if m is None:
            out.append(None)
            continue
        md = sum(abs(x - m) for x in tp[i - n + 1 : i + 1]) / n
        out.append(0.0 if md == 0 else (tp[i] - m) / (0.015 * md))
    return out


def _oscillator(vals: list[float | None], lower: float, upper: float, mid: float) -> list[int]:
    """Mean reversion on an oscillator: buy below lower, sell above upper, exit when it crosses mid."""
    pos, out = 0, []
    for v in vals:
        if v is None:
            out.append(0)
            continue
        if pos == 1 and v >= mid or pos == -1 and v <= mid:
            pos = 0
        if v < lower:
            pos = 1
        elif v > upper:
            pos = -1
        out.append(pos)
    return out


def signals(strategy: str, p: dict, bars: list[dict], rules: Rules | None = None) -> list[int]:
    """Desired position after each bar's close: 1 long, -1 short, 0 flat."""
    if strategy == "custom":
        if rules is None:
            raise ValueError("A custom strategy needs its rules")
        return custom_signals(rules, bars)
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
    if strategy == "ma_trend":
        avg = (_ema if p["ema"] else _sma)(c, int(p["period"]))
        return [0 if a is None else 1 if x > a else -1 if x < a else 0 for x, a in zip(c, avg)]
    if strategy == "macd":
        f, s = _ema(c, int(p["fast"])), _ema(c, int(p["slow"]))
        line = [None if a is None or b is None else a - b for a, b in zip(f, s)]
        sig = _ema_opt(line, int(p["signal"]))
        for a, b in zip(line, sig):
            if a is not None and b is not None and a != b:
                pos = 1 if a > b else -1
            out.append(pos)
        return out
    if strategy == "supertrend":
        return _supertrend(bars, int(p["period"]), p["mult"])
    if strategy == "parabolic_sar":
        return _psar(bars, p["step"], p["max_af"])
    if strategy == "adx_trend":
        adx, pdi, mdi = _adx(bars, int(p["period"]))
        for a, up, dn in zip(adx, pdi, mdi):
            out.append(0 if a is None or a < p["threshold"] or up == dn else 1 if up > dn else -1)
        return out
    if strategy == "keltner":
        mid, atr = _ema(c, int(p["period"])), _atr(bars, int(p["atr"]))
        for x, m, a in zip(c, mid, atr):
            if m is None or a is None:
                out.append(0)
                continue
            if pos == 1 and x <= m or pos == -1 and x >= m:
                pos = 0
            if x > m + p["mult"] * a:
                pos = 1
            elif x < m - p["mult"] * a:
                pos = -1
            out.append(pos)
        return out
    if strategy == "momentum":
        n, th = int(p["lookback"]), p["threshold"]
        for i, x in enumerate(c):
            if i < n:
                out.append(0)
                continue
            roc = (x / c[i - n] - 1) * 100
            out.append(1 if roc > th else -1 if roc < -th else 0)
        return out
    if strategy == "stochastic":
        k = _sma_opt(_range_position(bars, int(p["period"])), int(p["smooth"]))
        return _oscillator(k, p["lower"], p["upper"], 50)
    if strategy == "cci":
        return _oscillator(_cci(bars, int(p["period"])), -p["level"], p["level"], 0)
    if strategy == "williams_r":
        wr = [None if v is None else v - 100 for v in _range_position(bars, int(p["period"]))]
        return _oscillator(wr, p["lower"], p["upper"], -50)
    if strategy == "ichimoku":
        hs, ls = [b["h"] for b in bars], [b["l"] for b in bars]

        def mid(n: int) -> list[float | None]:
            return [None if i < n - 1 else (max(hs[i - n + 1 : i + 1]) + min(ls[i - n + 1 : i + 1])) / 2 for i in range(len(bars))]

        tk, kj, sb = mid(int(p["tenkan"])), mid(int(p["kijun"])), mid(int(p["senkou"]))
        shift = int(p["kijun"])
        for i, x in enumerate(c):
            j = i - shift  # the cloud plotted at bar i was computed shift bars earlier
            a = None if j < 0 or tk[j] is None or kj[j] is None else (tk[j] + kj[j]) / 2
            b = None if j < 0 else sb[j]
            if a is None or b is None or tk[i] is None or kj[i] is None:
                out.append(0)
                continue
            top, bot = max(a, b), min(a, b)
            if x > top and tk[i] > kj[i]:
                pos = 1
            elif x < bot and tk[i] < kj[i]:
                pos = -1
            elif bot <= x <= top:
                pos = 0
            out.append(pos)
        return out
    if strategy == "triple_ma":
        f, m, s = _ema(c, int(p["fast"])), _ema(c, int(p["mid"])), _ema(c, int(p["slow"]))
        return [0 if None in (a, b, d) else 1 if a > b > d else -1 if a < b < d else 0 for a, b, d in zip(f, m, s)]
    if strategy == "heikin_ashi":
        need, run_, ho, hc = int(p["confirm"]), 0, None, None
        for b in bars:
            nc = (b["o"] + b["h"] + b["l"] + b["c"]) / 4
            no = (b["o"] + b["c"]) / 2 if ho is None else (ho + hc) / 2
            ho, hc = no, nc
            d = 1 if hc > ho else -1 if hc < ho else 0
            run_ = run_ + d if d and (run_ == 0 or (run_ > 0) == (d > 0)) else d
            if run_ >= need:
                pos = 1
            elif run_ <= -need:
                pos = -1
            out.append(pos)
        return out
    if strategy == "aroon":
        n, th = int(p["period"]), p["threshold"]
        for i in range(len(bars)):
            if i < n:
                out.append(0)
                continue
            w = bars[i - n : i + 1]
            hi = max(range(n + 1), key=lambda k: (w[k]["h"], k))
            lo = min(range(n + 1), key=lambda k: (w[k]["l"], -k))
            up, dn = hi / n * 100, lo / n * 100
            if up >= th and up > dn:
                pos = 1
            elif dn >= th and dn > up:
                pos = -1
            out.append(pos)
        return out
    if strategy == "squeeze":
        n, k, look = int(p["period"]), p["width"], int(p["lookback"])
        mid, sd = _sma(c, n), _stdev(c, n)
        bw = [None if m is None else 2 * k * s / m for m, s in zip(mid, sd)]
        recent = deque(maxlen=look)
        armed = 0  # bars left in which a breakout counts after a squeeze
        for i, x in enumerate(c):
            if bw[i] is None:
                out.append(0)
                continue
            if len(recent) == look and bw[i] <= min(recent) * 1.05:
                armed = n
            recent.append(bw[i])
            up, lo = mid[i] + k * sd[i], mid[i] - k * sd[i]
            if pos == 1 and x <= mid[i] or pos == -1 and x >= mid[i]:
                pos = 0
            if armed and x > up:
                pos, armed = 1, 0
            elif armed and x < lo:
                pos, armed = -1, 0
            armed = max(armed - 1, 0)
            out.append(pos)
        return out
    if strategy == "inside_bar":
        hold, held, mother = int(p["hold"]), 0, None
        for i, b in enumerate(bars):
            if pos:
                held += 1
                if held >= hold:
                    pos = 0
            if mother and b["c"] > mother[0]:
                pos, held, mother = 1, 0, None
            elif mother and b["c"] < mother[1]:
                pos, held, mother = -1, 0, None
            if i and b["h"] <= bars[i - 1]["h"] and b["l"] >= bars[i - 1]["l"]:
                mother = (bars[i - 1]["h"], bars[i - 1]["l"])
            out.append(pos)
        return out
    if strategy == "rsi2_pullback":
        r, trend, short = _rsi(c, int(p["period"])), _sma(c, int(p["trend"])), _sma(c, 5)
        lvl = p["level"]
        for x, v, t, s5 in zip(c, r, trend, short):
            if v is None or t is None or s5 is None:
                out.append(0)
                continue
            if pos == 1 and x > s5 or pos == -1 and x < s5:
                pos = 0
            if x > t and v < lvl:
                pos = 1
            elif x < t and v > 100 - lvl:
                pos = -1
            out.append(pos)
        return out
    if strategy == "fib_pullback":
        n, f = int(p["lookback"]), p["level"] / 100
        hi, lo, trend = _rolling([b["h"] for b in bars], n, max), _rolling([b["l"] for b in bars], n, min), _sma(c, int(p["trend"]))
        target = stop = None
        for i, x in enumerate(c):
            if hi[i] is None or trend[i] is None:
                out.append(0)
                continue
            if pos == 1 and (x >= target or x < stop) or pos == -1 and (x <= target or x > stop):
                pos = 0
            if not pos:
                swing = hi[i] - lo[i]
                if x > trend[i] and lo[i] < x <= hi[i] - swing * f:
                    pos, target, stop = 1, hi[i], lo[i]
                elif x < trend[i] and hi[i] > x >= lo[i] + swing * f:
                    pos, target, stop = -1, lo[i], hi[i]
            out.append(pos)
        return out
    if strategy == "buy_and_hold":
        return [1] * len(bars)
    raise ValueError(f"unknown strategy {strategy}")


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class BacktestIn(BaseModel):
    strategy: Literal[tuple(STRATEGIES) + ("custom",)]  # type: ignore[valid-type]
    symbol: str = Field(config.SYMBOL, description="Market to test on (see /prices/markets)")
    params: dict[str, float] = {}
    rules: Rules | None = Field(None, description="The conditions of a custom strategy (strategy = custom)")
    tf: Literal["1h", "1d"] = "1d"
    start: date = date(2015, 1, 1)
    end: date | None = None
    direction: Literal["both", "long_only", "short_only"] = "both"
    capital: float = Field(10_000, gt=0, le=100_000_000)
    units: float | None = Field(None, gt=0, le=1_000_000_000, description=(
        "Units per trade (ounces for gold, shares, barrels, currency units...); default is the market's usual size"))
    size_pct: float | None = Field(None, gt=0, le=10_000, description=(
        "If set, each trade's size is this % of the account at entry (100 = 1x, 500 = 5x leverage), "
        "and units is ignored"))
    spread: float | None = Field(None, ge=0, le=100_000, description=(
        "In price units, paid once per round trip; default is the market's typical spread"))
    swap_long: float | None = Field(None, ge=-10_000, le=10_000, description=(
        "USD per unit per night held long (negative = cost); default is the market's financing rate"))
    swap_short: float | None = Field(None, ge=-10_000, le=10_000, description="USD per unit per night held short")
    stop_loss_pct: float | None = Field(None, gt=0, le=50)
    take_profit_pct: float | None = Field(None, gt=0, le=200)

    @property
    def market(self) -> ins.Instrument:
        return ins.get(self.symbol)

    def swap_for(self, side: int, price: float) -> float:
        """Financing per unit per night: the fixed value if one was given, else the market's rate at this price."""
        fixed = self.swap_long if side == 1 else self.swap_short
        return fixed if fixed is not None else self.market.swap_per_unit("long" if side == 1 else "short", price)

    @model_validator(mode="after")
    def _check(self):
        try:
            m = ins.get(self.symbol)
        except KeyError:
            raise ValueError(f"Unknown market {self.symbol}")
        self.symbol = m.symbol
        if self.units is None:
            self.units = m.default_units
        if self.spread is None:
            self.spread = m.spread
        if self.strategy == "custom":
            if self.rules is None:
                raise ValueError("A custom strategy needs its rules")
            if self.end and self.end <= self.start:
                raise ValueError("The end date must be after the start date")
            self.params = {}
            return self
        self.rules = None
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
        if self.strategy == "macd" and full["fast"] >= full["slow"]:
            raise ValueError("The fast average must be shorter than the slow average")
        if self.strategy == "triple_ma" and not full["fast"] < full["mid"] < full["slow"]:
            raise ValueError("The averages must go from fast to middle to slow")
        if self.strategy == "ichimoku" and not full["tenkan"] < full["kijun"] < full["senkou"]:
            raise ValueError("The Ichimoku lengths must go from conversion to base to leading span B")
        if "lower" in full and full["lower"] >= full["upper"]:
            raise ValueError("The oversold level must be below the overbought level")
        if self.end and self.end <= self.start:
            raise ValueError("The end date must be after the start date")
        self.params = full
        return self


def run(cfg: BacktestIn, bars: list[dict]) -> dict:
    if len(bars) < 2:
        raise ValueError("Not enough price data in that date range")
    target = signals(cfg.strategy, cfg.params, bars, cfg.rules)
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
            "units": round(u, 4),
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
        nonlocal pos, entry, entry_t, u
        pos, entry, entry_t = side, (bid + sp if side == 1 else bid), t
        if cfg.size_pct:
            u = max(cash, 0) * cfg.size_pct / 100 / entry

    for i in range(1, len(bars)):
        b, prev = bars[i], bars[i - 1]
        # Overnight financing for each trading-day rollover the position was held through.
        if pos:
            nights = (trading_date(b["t"]) - trading_date(prev["t"])).days
            if nights > 0:
                swap_acc += nights * u * cfg.swap_for(pos, entry)

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


def load_bars(tf: str, start: date, end: date | None, symbol: str = config.SYMBOL) -> list[dict]:
    s = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    sql = "SELECT extract(epoch FROM ts)::bigint AS t, open AS o, high AS h, low AS l, close AS c FROM candles WHERE symbol = %s AND tf = %s AND ts >= %s"
    args: list = [symbol, tf, s]
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
    return [{"key": k, "kind_label": KINDS[v["kind"]], **v} for k, v in STRATEGIES.items()]


@router.post("", status_code=201)
def create(cfg: BacktestIn, user: UserOut = Depends(current_user)):
    try:
        rep = run(cfg, load_bars(cfg.tf, cfg.start, cfg.end, cfg.symbol))
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
