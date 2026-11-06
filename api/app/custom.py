"""Custom strategies: rules a user builds from indicators, saved per user and run by the
backtester, the strategy finder and the paper-trading agent like any built-in strategy.

A strategy is four lists of conditions: long entry, long exit, short entry and short exit.
Every condition in a list must hold on a bar's close for that list to fire. Each condition
compares two operands (an indicator, the price or a fixed number) with >, <, crosses above
or crosses below."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, model_validator

from . import db
from .auth import UserOut, current_user

router = APIRouter(prefix="/custom-strategies", tags=["custom strategies"])

# Indicator catalogue. n and m are the indicator's settings, with their labels and defaults.
INDICATORS: dict[str, dict] = {
    "close": {"label": "Close price", "group": "Price"},
    "open": {"label": "Open price", "group": "Price"},
    "high": {"label": "High", "group": "Price"},
    "low": {"label": "Low", "group": "Price"},
    "sma": {"label": "Simple moving average", "group": "Trend", "n": ("Length", 50)},
    "ema": {"label": "Exponential moving average", "group": "Trend", "n": ("Length", 20)},
    "highest": {"label": "Highest high of the previous bars", "group": "Trend", "n": ("Bars", 20)},
    "lowest": {"label": "Lowest low of the previous bars", "group": "Trend", "n": ("Bars", 20)},
    "adx": {"label": "ADX (trend strength)", "group": "Trend", "n": ("Length", 14)},
    "plus_di": {"label": "+DI (upward pressure)", "group": "Trend", "n": ("Length", 14)},
    "minus_di": {"label": "-DI (downward pressure)", "group": "Trend", "n": ("Length", 14)},
    "macd": {"label": "MACD line", "group": "Momentum", "n": ("Fast", 12), "m": ("Slow", 26)},
    "macd_signal": {"label": "MACD signal line", "group": "Momentum", "n": ("Fast", 12), "m": ("Slow", 26)},
    "rsi": {"label": "RSI", "group": "Momentum", "n": ("Length", 14)},
    "stoch": {"label": "Stochastic %K", "group": "Momentum", "n": ("Length", 14)},
    "cci": {"label": "CCI", "group": "Momentum", "n": ("Length", 20)},
    "williams_r": {"label": "Williams %R", "group": "Momentum", "n": ("Length", 14)},
    "roc": {"label": "Change over N bars (%)", "group": "Momentum", "n": ("Bars", 10)},
    "bb_upper": {"label": "Bollinger upper band", "group": "Volatility", "n": ("Length", 20), "m": ("Width (sd)", 2)},
    "bb_lower": {"label": "Bollinger lower band", "group": "Volatility", "n": ("Length", 20), "m": ("Width (sd)", 2)},
    "atr_pct": {"label": "ATR as % of price", "group": "Volatility", "n": ("Length", 14)},
    "value": {"label": "A number", "group": "Number"},
}
OPS = {">": "is above", "<": "is below", "crosses_above": "crosses above", "crosses_below": "crosses below"}
MAX_CONDITIONS = 6
MAX_SAVED = 50


class Operand(BaseModel):
    ind: Literal[tuple(INDICATORS)]  # type: ignore[valid-type]
    n: float | None = Field(None, ge=1, le=500)
    m: float | None = Field(None, gt=0, le=500)
    value: float | None = Field(None, ge=-1_000_000, le=1_000_000)

    @model_validator(mode="after")
    def _fill(self):
        spec = INDICATORS[self.ind]
        if self.ind == "value":
            if self.value is None:
                raise ValueError("Enter a number to compare with")
            self.n = self.m = None
            return self
        self.value = None
        self.n = (self.n if self.n is not None else spec["n"][1]) if "n" in spec else None
        self.m = (self.m if self.m is not None else spec["m"][1]) if "m" in spec else None
        if self.ind in ("macd", "macd_signal") and self.n >= self.m:
            raise ValueError("The MACD fast length must be shorter than the slow length")
        return self

    def key(self) -> tuple:
        return (self.ind, self.n, self.m, self.value)


class Condition(BaseModel):
    left: Operand
    op: Literal[tuple(OPS)]  # type: ignore[valid-type]
    right: Operand

    @model_validator(mode="after")
    def _check(self):
        if self.left.ind == "value":
            raise ValueError("Start each condition with a price or an indicator, not a number")
        return self


class Rules(BaseModel):
    name: str = Field("My strategy", min_length=1, max_length=60)
    long_entry: list[Condition] = Field([], max_length=MAX_CONDITIONS)
    long_exit: list[Condition] = Field([], max_length=MAX_CONDITIONS)
    short_entry: list[Condition] = Field([], max_length=MAX_CONDITIONS)
    short_exit: list[Condition] = Field([], max_length=MAX_CONDITIONS)

    @model_validator(mode="after")
    def _check(self):
        self.name = self.name.strip() or "My strategy"
        if not self.long_entry and not self.short_entry:
            raise ValueError("Add at least one condition for entering a long or a short trade")
        return self


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def _series(o: Operand, bars: list[dict], cache: dict) -> list[float | None]:
    from . import backtest as bt

    k = o.key()
    if k in cache:
        return cache[k]
    c = [b["c"] for b in bars]
    n = int(o.n) if o.n is not None else 0
    ind = o.ind
    if ind == "value":
        out = [o.value] * len(bars)
    elif ind in ("close", "open", "high", "low"):
        out = [b[ind[0]] for b in bars]
    elif ind == "sma":
        out = bt._sma(c, n)
    elif ind == "ema":
        out = bt._ema(c, n)
    elif ind in ("highest", "lowest"):
        # The previous n bars only, so "close above the highest high" can happen.
        out = bt._rolling([b["h" if ind == "highest" else "l"] for b in bars], n, max if ind == "highest" else min)
    elif ind in ("adx", "plus_di", "minus_di"):
        adx, pdi, mdi = bt._adx(bars, n)
        out = {"adx": adx, "plus_di": pdi, "minus_di": mdi}[ind]
    elif ind in ("macd", "macd_signal"):
        f, s = bt._ema(c, n), bt._ema(c, int(o.m))
        line = [None if a is None or b is None else a - b for a, b in zip(f, s)]
        out = line if ind == "macd" else bt._ema_opt(line, 9)
    elif ind == "rsi":
        out = bt._rsi(c, n)
    elif ind == "stoch":
        out = bt._range_position(bars, n)
    elif ind == "cci":
        out = bt._cci(bars, n)
    elif ind == "williams_r":
        out = [None if v is None else v - 100 for v in bt._range_position(bars, n)]
    elif ind == "roc":
        out = [None if i < n or not c[i - n] else (c[i] / c[i - n] - 1) * 100 for i in range(len(c))]
    elif ind in ("bb_upper", "bb_lower"):
        mid, sd = bt._sma(c, n), bt._stdev(c, n)
        sign = 1 if ind == "bb_upper" else -1
        out = [None if a is None else a + sign * o.m * s for a, s in zip(mid, sd)]
    elif ind == "atr_pct":
        out = [None if a is None else a / x * 100 for a, x in zip(bt._atr(bars, n), c)]
    else:  # pragma: no cover - guarded by the Literal
        raise ValueError(ind)
    cache[k] = out
    return out


def _fires(conds: list[Condition], bars: list[dict], cache: dict) -> list[bool]:
    size = len(bars)
    if not conds:
        return [False] * size
    out = [True] * size
    for cond in conds:
        a, b = _series(cond.left, bars, cache), _series(cond.right, bars, cache)
        for i in range(size):
            if not out[i]:
                continue
            x, y = a[i], b[i]
            if x is None or y is None:
                out[i] = False
            elif cond.op == ">":
                out[i] = x > y
            elif cond.op == "<":
                out[i] = x < y
            else:
                px, py = (a[i - 1], b[i - 1]) if i else (None, None)
                if px is None or py is None:
                    out[i] = False
                elif cond.op == "crosses_above":
                    out[i] = px <= py and x > y
                else:
                    out[i] = px >= py and x < y
    return out


def signals(rules: Rules, bars: list[dict]) -> list[int]:
    """Desired position after each bar's close. An entry on the other side flips the position;
    an exit closes it; a bar where both entries fire keeps the current position."""
    cache: dict = {}
    le, lx = _fires(rules.long_entry, bars, cache), _fires(rules.long_exit, bars, cache)
    se, sx = _fires(rules.short_entry, bars, cache), _fires(rules.short_exit, bars, cache)
    pos, out = 0, []
    for i in range(len(bars)):
        if pos == 1 and lx[i]:
            pos = 0
        elif pos == -1 and sx[i]:
            pos = 0
        if le[i] and not se[i]:
            pos = 1
        elif se[i] and not le[i]:
            pos = -1
        out.append(pos)
    return out


def describe(rules: Rules) -> str:
    """The rules in one plain sentence per side, for logs and the assistant."""
    def op(o: Operand) -> str:
        if o.ind == "value":
            return f"{o.value:g}"
        spec, label = INDICATORS[o.ind], INDICATORS[o.ind]["label"]
        args = [f"{v:g}" for v in (o.n, o.m) if v is not None and ("n" in spec or "m" in spec)]
        return f"{label}{' (' + ', '.join(args) + ')' if args else ''}"

    def group(conds: list[Condition]) -> str:
        return " and ".join(f"{op(c.left)} {OPS[c.op]} {op(c.right)}" for c in conds)

    parts = []
    for side in ("long", "short"):
        e, x = getattr(rules, f"{side}_entry"), getattr(rules, f"{side}_exit")
        if e:
            parts.append(f"{side.title()} when {group(e)}" + (f"; exit when {group(x)}" if x else "") + ".")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Templates and API
# ---------------------------------------------------------------------------


def _o(ind: str, n: float | None = None, m: float | None = None, value: float | None = None) -> dict:
    return {"ind": ind, "n": n, "m": m, "value": value}


TEMPLATES = [
    {"key": "golden_cross", "name": "Golden cross", "summary": "Long when the 50-bar average crosses above the 200-bar one; out when it crosses back.",
     "rules": {"long_entry": [{"left": _o("sma", 50), "op": "crosses_above", "right": _o("sma", 200)}],
               "long_exit": [{"left": _o("sma", 50), "op": "crosses_below", "right": _o("sma", 200)}]}},
    {"key": "rsi_dip_uptrend", "name": "RSI dip in an uptrend", "summary": "Buy when RSI(14) falls below 35 while price is above its 200-bar average; sell when RSI gets back above 55.",
     "rules": {"long_entry": [{"left": _o("rsi", 14), "op": "<", "right": _o("value", value=35)},
                              {"left": _o("close"), "op": ">", "right": _o("sma", 200)}],
               "long_exit": [{"left": _o("rsi", 14), "op": ">", "right": _o("value", value=55)}]}},
    {"key": "strong_trend_breakout", "name": "Breakout with a strong trend", "summary": "Trade a close beyond the 20-bar high or low, but only while ADX shows a strong trend.",
     "rules": {"long_entry": [{"left": _o("close"), "op": ">", "right": _o("highest", 20)},
                              {"left": _o("adx", 14), "op": ">", "right": _o("value", value=25)}],
               "long_exit": [{"left": _o("close"), "op": "<", "right": _o("lowest", 10)}],
               "short_entry": [{"left": _o("close"), "op": "<", "right": _o("lowest", 20)},
                               {"left": _o("adx", 14), "op": ">", "right": _o("value", value=25)}],
               "short_exit": [{"left": _o("close"), "op": ">", "right": _o("highest", 10)}]}},
    {"key": "macd_trend_filter", "name": "MACD with a trend filter", "summary": "MACD crossovers, taken only in the direction of the 100-bar EMA.",
     "rules": {"long_entry": [{"left": _o("macd", 12, 26), "op": "crosses_above", "right": _o("macd_signal", 12, 26)},
                              {"left": _o("close"), "op": ">", "right": _o("ema", 100)}],
               "long_exit": [{"left": _o("macd", 12, 26), "op": "crosses_below", "right": _o("macd_signal", 12, 26)}],
               "short_entry": [{"left": _o("macd", 12, 26), "op": "crosses_below", "right": _o("macd_signal", 12, 26)},
                               {"left": _o("close"), "op": "<", "right": _o("ema", 100)}],
               "short_exit": [{"left": _o("macd", 12, 26), "op": "crosses_above", "right": _o("macd_signal", 12, 26)}]}},
    {"key": "band_fade", "name": "Fade the Bollinger bands", "summary": "Buy a close below the lower band, sell a close above the upper band, out at the 20-bar average.",
     "rules": {"long_entry": [{"left": _o("close"), "op": "<", "right": _o("bb_lower", 20, 2)}],
               "long_exit": [{"left": _o("close"), "op": ">", "right": _o("sma", 20)}],
               "short_entry": [{"left": _o("close"), "op": ">", "right": _o("bb_upper", 20, 2)}],
               "short_exit": [{"left": _o("close"), "op": "<", "right": _o("sma", 20)}]}},
]


class SavedIn(BaseModel):
    rules: Rules


class PreviewIn(BaseModel):
    rules: Rules
    tf: Literal["1d", "1h"] = "1d"
    years: float = Field(3, ge=0.25, le=25)
    stop_loss_pct: float | None = Field(None, gt=0, le=50)


PREVIEW_BARS = 4000  # candles sent back for the chart; the test itself uses the whole period


def preview(body: PreviewIn) -> dict:
    """Run the rules on past prices without saving anything, for the builder's live chart."""
    from datetime import date, timedelta

    from . import backtest as bt

    start = date.today() - timedelta(days=round(body.years * 365.25))
    cfg = bt.BacktestIn(strategy="custom", rules=body.rules, tf=body.tf, start=start, capital=10_000, size_pct=100,
                        stop_loss_pct=body.stop_loss_pct)
    bars = bt.load_bars(cfg.tf, cfg.start, None)
    if len(bars) < 30:
        raise HTTPException(422, "Not enough price history for that period yet")
    rep = bt.run(cfg, bars)
    sig = bt.signals("custom", {}, bars, body.rules)
    return {
        "stats": rep["stats"],
        "equity": rep["equity"],
        "trades": [{k: t.get(k) for k in ("side", "entry_time", "entry_price", "exit_time", "exit_price", "pnl", "exit_reason")}
                   for t in rep["trades"]],
        "candles": [{k: b[k] for k in ("t", "o", "h", "l", "c")} for b in bars[-PREVIEW_BARS:]],
        "in_market_pct": round(sum(1 for x in sig if x) / len(sig) * 100, 1),
        "description": describe(body.rules),
    }


def _row(r: dict) -> dict:
    rules = Rules(**r["rules"])
    return {"id": r["id"], "name": rules.name, "rules": rules.model_dump(), "description": describe(rules),
            "created_at": r["created_at"], "updated_at": r["updated_at"]}


def owned(user_id: int, sid: int) -> Rules:
    with db.conn() as c:
        r = c.execute("SELECT rules FROM custom_strategies WHERE id = %s AND user_id = %s", (sid, user_id)).fetchone()
    if not r:
        raise HTTPException(404, "Custom strategy not found")
    return Rules(**r["rules"])


@router.get("/catalog")
def catalog():
    return {
        "indicators": [{"key": k, "label": v["label"], "group": v["group"],
                        "n": {"label": v["n"][0], "default": v["n"][1]} if "n" in v else None,
                        "m": {"label": v["m"][0], "default": v["m"][1]} if "m" in v else None} for k, v in INDICATORS.items()],
        "ops": [{"key": k, "label": v} for k, v in OPS.items()],
        "templates": [{**t, "rules": Rules(name=t["name"], **t["rules"]).model_dump()} for t in TEMPLATES],
        "max_conditions": MAX_CONDITIONS,
    }


def saved(user_id: int) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT * FROM custom_strategies WHERE user_id = %s ORDER BY updated_at DESC", (user_id,)).fetchall()
    return [_row(r) for r in rows]


@router.post("/preview")
def preview_route(body: PreviewIn, user: UserOut = Depends(current_user)):
    try:
        return preview(body)
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("")
def list_(user: UserOut = Depends(current_user)):
    return saved(user.id)


@router.post("")
def create(body: SavedIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        n = c.execute("SELECT count(*) AS n FROM custom_strategies WHERE user_id = %s", (user.id,)).fetchone()["n"]
        if n >= MAX_SAVED:
            raise HTTPException(409, f"You can save up to {MAX_SAVED} strategies. Delete one to add another.")
        r = c.execute("INSERT INTO custom_strategies (user_id, rules) VALUES (%s, %s) RETURNING *",
                      (user.id, Jsonb(body.rules.model_dump()))).fetchone()
    return _row(r)


@router.put("/{sid}")
def update(sid: int, body: SavedIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        r = c.execute("UPDATE custom_strategies SET rules = %s, updated_at = now() WHERE id = %s AND user_id = %s RETURNING *",
                      (Jsonb(body.rules.model_dump()), sid, user.id)).fetchone()
    if not r:
        raise HTTPException(404, "Custom strategy not found")
    return _row(r)


@router.delete("/{sid}")
def delete(sid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        r = c.execute("DELETE FROM custom_strategies WHERE id = %s AND user_id = %s RETURNING id", (sid, user.id)).fetchone()
    if not r:
        raise HTTPException(404, "Custom strategy not found")
    return {"ok": True}
