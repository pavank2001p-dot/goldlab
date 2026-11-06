"""Strategy agent: tests a strategy on past prices, runs it automatically on live prices in the
user's paper account, and explains what went wrong in both, with fixes tested on the same prices.

The explanations are worked out from the data here: the market regime (trend or range, calm or
volatile) around each trade, stop distances against normal volatility, costs, direction, losing
streaks and the worst drawdown, with the Fed and inflation dates and gold headlines from that time.
The AI coach (the assistant) only puts these results into words. Nothing here is advice to trade,
and the agent only ever trades virtual money."""

import logging
import statistics
from bisect import bisect_right
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, ValidationError, model_validator

from . import backtest as bt
from . import config, db, paper
from .auth import UserOut, current_user
from .fit import assess
from .report import build_report
from .risk import profile_of

log = logging.getLogger("agent")
router = APIRouter(prefix="/agent", tags=["agent"])

TF_SECONDS = {"1h": 3600, "1d": 86400}
WARMUP_BARS = 600  # bars of history the live agent computes its signal on
HOLDOUT = 0.3  # fixes are also checked on the last 30% of the test on their own
AGENT_KIND = "agent"


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


class AgentConfig(BaseModel):
    strategy: Literal[tuple(k for k in bt.STRATEGIES if k != "buy_and_hold")]  # type: ignore[valid-type]
    params: dict[str, float] = {}
    tf: Literal["1h", "1d"] = "1d"
    direction: Literal["both", "long_only", "short_only"] = "both"
    stop_loss_pct: float = Field(3, gt=0, le=50)
    size_pct: float = Field(33, gt=0, le=2000, description="Each position's value as a % of the account")

    @model_validator(mode="after")
    def _check(self):
        # Reuse the backtester's checks on the strategy settings.
        try:
            cfg = bt.BacktestIn(strategy=self.strategy, params=self.params, tf=self.tf, direction=self.direction)
        except ValidationError as e:
            raise ValueError(e.errors()[0]["msg"].removeprefix("Value error, "))
        self.params = cfg.params
        return self

    def backtest(self, capital: float = 10_000, **changes) -> bt.BacktestIn:
        d = {"strategy": self.strategy, "params": self.params, "tf": self.tf, "direction": self.direction,
             "stop_loss_pct": self.stop_loss_pct, "size_pct": self.size_pct, **changes}
        return bt.BacktestIn(capital=capital, start=date(2000, 1, 1), **d)


class PastIn(AgentConfig):
    years: float = Field(5, ge=0.25, le=25)


# ---------------------------------------------------------------------------
# Market regime
# ---------------------------------------------------------------------------


def regimes(bars: list[dict]) -> list[dict]:
    """For each bar: trend ('up', 'down' or 'range') from ADX(14) and the 50-bar average, and
    volatility (ATR(14) as % of price, and whether it is in the top quarter for the period)."""
    closes = [b["c"] for b in bars]
    adx, pdi, mdi = bt._adx(bars, 14)
    sma = bt._sma(closes, 50)
    atr = bt._atr(bars, 14)
    atr_pct = [None if a is None else a / b["c"] * 100 for a, b in zip(atr, bars)]
    known = sorted(x for x in atr_pct if x is not None)
    high = known[int(len(known) * 0.75)] if known else None
    out = []
    for i, b in enumerate(bars):
        trend = "range"
        if adx[i] is not None and adx[i] >= 25 and sma[i] is not None:
            if pdi[i] > mdi[i] and b["c"] > sma[i]:
                trend = "up"
            elif mdi[i] > pdi[i] and b["c"] < sma[i]:
                trend = "down"
        out.append({"trend": trend, "atr_pct": atr_pct[i], "volatile": bool(high and atr_pct[i] and atr_pct[i] >= high)})
    return out


TREND_LABEL = {"up": "a strong uptrend", "down": "a strong downtrend", "range": "a sideways market"}


# ---------------------------------------------------------------------------
# What went wrong
# ---------------------------------------------------------------------------


def _day(t: int) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%d %b %Y")


def _r(x, n=2):
    return None if x is None else round(x, n)


def _context(start: int, end: int) -> dict:
    """Scheduled events and gold headlines between two times."""
    s, e = datetime.fromtimestamp(start, timezone.utc), datetime.fromtimestamp(end, timezone.utc)
    with db.conn() as c:
        events = c.execute("SELECT ts, title FROM events WHERE ts >= %s AND ts <= %s ORDER BY ts LIMIT 200", (s, e)).fetchall()
        news = c.execute(
            """SELECT published_at, headline, impact, reason FROM news WHERE published_at >= %s AND published_at <= %s
               AND relevance = 2 AND impact IS NOT NULL ORDER BY published_at DESC LIMIT 8""", (s, e)).fetchall()
    kinds: dict[str, int] = {}
    for ev in events:
        t = ev["title"].lower()
        k = ("Fed meetings" if "fomc" in t or "fed" in t else "inflation reports" if "cpi" in t or "inflation" in t or "pce" in t
             else "jobs reports" if "payroll" in t or "employment" in t or "jobs" in t else "other big releases")
        kinds[k] = kinds.get(k, 0) + 1
    return {
        "events": kinds,
        "event_list": [{"date": ev["ts"].strftime("%d %b %Y"), "title": ev["title"]} for ev in events[:12]],
        "headlines": [{"date": n["published_at"].strftime("%d %b %Y"), "headline": n["headline"], "impact": n["impact"],
                       "reason": n["reason"]} for n in news],
    }


def diagnose(bars: list[dict], trades: list[dict], equity: list[dict], strategy: str, stop_pct: float | None,
             capital: float, profile: str | None) -> dict:
    """Explain a set of trades against the market they were made in.
    bars: the price bars the trades ran on (t, o, h, l, c); trades: report trades; equity: report curve."""
    kind = bt.STRATEGIES[strategy]["kind"]
    closed = [t for t in trades if t.get("exit_time") is not None]
    reg = regimes(bars) if bars else []
    times = [b["t"] for b in bars]

    def at(t: int) -> int:
        return max(bisect_right(times, t) - 1, 0)

    rows = []
    for t in closed:
        i, j = at(t["entry_time"]), at(t["exit_time"])
        r = reg[i] if reg else {"trend": "range", "atr_pct": None, "volatile": False}
        span = bars[i : j + 1] or bars[i : i + 1]
        if t["side"] == "long":
            adverse = (min(b["l"] for b in span) / t["entry_price"] - 1) * 100
            with_trend = r["trend"] == "up"
        else:
            adverse = (1 - max(b["h"] for b in span) / t["entry_price"]) * 100
            with_trend = r["trend"] == "down"
        rows.append({**t, "trend": r["trend"], "volatile": r["volatile"], "atr_pct": r["atr_pct"],
                     "adverse_pct": adverse, "with_trend": with_trend})

    findings: list[dict] = []
    losses = [r for r in rows if r["pnl"] <= 0]
    total_loss = -sum(r["pnl"] for r in losses) or 1.0

    # 1. Regime: where the money was lost.
    by_trend = {}
    for name in ("up", "down", "range"):
        g = [r for r in rows if r["trend"] == name]
        by_trend[name] = {"trades": len(g), "pnl": _r(sum(r["pnl"] for r in g)),
                          "win_rate_pct": _r(sum(r["pnl"] > 0 for r in g) / len(g) * 100, 1) if g else None}
    worst_trend = min(by_trend, key=lambda k: by_trend[k]["pnl"] or 0)
    wt = by_trend[worst_trend]
    share = -sum(r["pnl"] for r in losses if r["trend"] == worst_trend) / total_loss * 100
    if wt["trades"] and (wt["pnl"] or 0) < 0 and share >= 30:
        if kind == "trend" and worst_trend == "range":
            title, why = "Whipsawed in sideways markets", (
                "Trend-following signals flip back and forth when gold moves sideways, so each new trade starts "
                "just before the move fades.")
        elif kind == "reversion" and worst_trend != "range":
            title, why = f"Fought {TREND_LABEL[worst_trend]}", (
                "Mean-reversion trades bet on a bounce, but in a strong trend 'oversold' can keep getting more oversold.")
        else:
            title, why = f"Lost most in {TREND_LABEL[worst_trend]}", "This kind of market was the hardest for the strategy."
        findings.append({"key": "regime", "severity": "high" if share >= 50 else "medium", "title": title,
                         "detail": f"{wt['trades']} trades opened in {TREND_LABEL[worst_trend]} lost ${-wt['pnl']:,.0f} "
                                   f"in total ({share:.0f}% of all losses), winning {wt['win_rate_pct'] or 0:.0f}% of the time. {why}"})

    # 2. Trades against the trend.
    against = [r for r in rows if r["trend"] != "range" and not r["with_trend"]]
    if len(against) >= 3 and sum(r["pnl"] for r in against) < 0 and kind != "reversion":
        findings.append({"key": "against_trend", "severity": "medium", "title": "Traded against the main trend",
                         "detail": f"{len(against)} trades went the opposite way to a strong trend and lost "
                                   f"${-sum(r['pnl'] for r in against):,.0f} together."})

    # 3. Direction.
    longs = sum(r["pnl"] for r in rows if r["side"] == "long")
    shorts = sum(r["pnl"] for r in rows if r["side"] == "short")
    move = (bars[-1]["c"] / bars[0]["c"] - 1) * 100 if bars else 0
    n_short = sum(r["side"] == "short" for r in rows)
    n_long = len(rows) - n_short
    if n_short >= 3 and shorts < 0 and move > 0:
        findings.append({"key": "shorts", "severity": "high" if shorts < -abs(longs) / 2 else "medium",
                         "title": "Shorts lost in a rising market",
                         "detail": f"Gold rose {move:.0f}% over the test. The {n_short} short trades lost ${-shorts:,.0f}, "
                                   f"while the longs {'made' if longs >= 0 else 'lost'} ${abs(longs):,.0f}."})
    elif n_long >= 3 and longs < 0 and move < 0:
        findings.append({"key": "longs", "severity": "medium", "title": "Longs lost in a falling market",
                         "detail": f"Gold fell {-move:.0f}% over the test. The {n_long} long trades lost ${-longs:,.0f}."})

    # 4. Stops against normal volatility.
    stopped = [r for r in rows if r.get("exit_reason") == "stop_loss" and r["atr_pct"]]
    median_atr = statistics.median([r["atr_pct"] for r in rows if r["atr_pct"]] or [0]) or None
    if stop_pct and stopped:
        tight = [r for r in stopped if stop_pct < r["atr_pct"]]
        if len(stopped) >= 3 and len(tight) / len(stopped) >= 0.4:
            findings.append({"key": "tight_stops", "severity": "high", "title": "Stops sat inside normal price noise",
                             "detail": f"{len(tight)} of {len(stopped)} stop-outs had a {stop_pct}% stop when gold's usual "
                                       f"{'hourly' if len(bars) > 1 and bars[1]['t'] - bars[0]['t'] < 86400 else 'daily'} range "
                                       f"(ATR) was wider, so ordinary swings closed trades that might have recovered."})
        elif len(stopped) >= 3 and len(stopped) / max(len(rows), 1) >= 0.5:
            findings.append({"key": "many_stops", "severity": "medium", "title": "Most trades ended at the stop",
                             "detail": f"{len(stopped)} of {len(rows)} trades were closed by the {stop_pct}% stop loss."})

    # 5. Volatile periods.
    vol = [r for r in rows if r["volatile"]]
    rest = [r for r in rows if not r["volatile"]]
    calm = sum(r["pnl"] for r in rest)
    # Only when volatile trades did worse per trade than the others.
    if len(vol) >= 3 and sum(r["pnl"] for r in vol) < 0 and sum(r["pnl"] for r in vol) / len(vol) < calm / max(len(rest), 1):
        findings.append({"key": "volatility", "severity": "medium", "title": "Lost when gold was most volatile",
                         "detail": f"Trades opened in the most volatile quarter of the period lost ${-sum(r['pnl'] for r in vol):,.0f}; "
                                   f"the rest {'made' if calm >= 0 else 'lost'} ${abs(calm):,.0f}."})

    # 6. Costs.
    costs = sum(t.get("costs") or 0 for t in closed)
    swap = sum(t.get("swap") or 0 for t in closed)
    gross_win = sum(t["pnl"] for t in closed if t["pnl"] > 0)
    paid = costs + max(-swap, 0)
    if closed and paid > 0 and (gross_win <= 0 or paid / gross_win >= 0.25):
        findings.append({"key": "costs", "severity": "medium" if gross_win > 0 and paid / gross_win < 0.5 else "high",
                         "title": "Costs ate the profits",
                         "detail": f"Spread and overnight swap cost ${paid:,.0f} across {len(closed)} trades"
                                   + (f", {paid / gross_win * 100:.0f}% of what the winning trades made." if gross_win > 0 else ".")})

    # 7. Losing streak.
    streak, best, s_from, s_to, cur_from = 0, 0, None, None, None
    for r in rows:
        if r["pnl"] <= 0:
            cur_from = r["entry_time"] if streak == 0 else cur_from
            streak += 1
            if streak > best:
                best, s_from, s_to = streak, cur_from, r["exit_time"]
        else:
            streak = 0
    if best >= 5:
        findings.append({"key": "streak", "severity": "medium", "title": f"{best} losses in a row",
                         "detail": f"From {_day(s_from)} to {_day(s_to)}. Long losing streaks are where most people "
                                   "abandon a plan or raise their size to win it back."})

    # Worst drawdown: when, how deep, and what the market was doing.
    worst = None
    if equity:
        peak_i, trough_i, best_dd, pk = 0, 0, 0.0, 0
        for i, p in enumerate(equity):
            if p["equity"] >= equity[pk]["equity"]:
                pk = i
            dd = p["equity"] / equity[pk]["equity"] - 1 if equity[pk]["equity"] > 0 else 0
            if dd < best_dd:
                best_dd, peak_i, trough_i = dd, pk, i
        if best_dd < 0:
            t0, t1 = equity[peak_i]["t"], equity[trough_i]["t"]
            i0, i1 = at(t0), at(t1)
            win = reg[i0 : i1 + 1]
            mix = {k: sum(w["trend"] == k for w in win) for k in ("up", "down", "range")}
            during = [r for r in rows if t0 <= r["exit_time"] <= t1]
            worst = {
                "from": _day(t0), "to": _day(t1), "depth_pct": _r(best_dd * 100),
                "gold_move_pct": _r((bars[i1]["c"] / bars[i0]["c"] - 1) * 100) if bars else None,
                "market": max(mix, key=mix.get) if win else None,
                "market_label": TREND_LABEL[max(mix, key=mix.get)] if win else None,
                "trades": len(during), "losing_trades": sum(r["pnl"] <= 0 for r in during),
                "stop_outs": sum(r.get("exit_reason") == "stop_loss" for r in during),
                **_context(t0, t1),
            }

    fit = assess(trades, {"max_drawdown_pct": min((p["drawdown"] for p in equity), default=0)}, capital, profile,
                 stop_pct) if profile and closed else None
    if fit and fit["verdict"] != "fits":
        over = [c["label"].lower() for c in fit["checks"] if c["level"] != "fits"]
        findings.append({"key": "profile", "severity": "high", "title": "Outside your risk limits",
                         "detail": f"Your {fit['profile_label'].lower()} profile was exceeded on: {', '.join(over)}."})

    order = {"high": 0, "medium": 1, "info": 2}
    findings.sort(key=lambda f: order[f["severity"]])
    if not findings and closed:
        findings.append({"key": "ok", "severity": "info", "title": "Nothing stood out",
                         "detail": "No market condition, direction, stop or cost explained a large share of the losses."})
    return {
        "findings": findings,
        "by_market": by_trend,
        "worst_period": worst,
        "median_atr_pct": _r(median_atr),
        "gold_move_pct": _r(move),
        "fit": fit and {"verdict": fit["verdict"], "verdict_label": fit["verdict_label"], "checks": fit["checks"]},
    }


# ---------------------------------------------------------------------------
# Fixes, tested on the same prices
# ---------------------------------------------------------------------------


def _brief(rep: dict) -> dict:
    s = rep["stats"]
    return {k: s.get(k) for k in ("total_return_pct", "cagr_pct", "max_drawdown_pct", "trades", "win_rate_pct",
                                  "profit_factor", "wiped_out")}


def _calmar(s: dict) -> float:
    if s.get("wiped_out"):
        return float("-inf")
    return (s.get("cagr_pct") if s.get("cagr_pct") is not None else s.get("total_return_pct") or 0) / max(abs(s.get("max_drawdown_pct") or 0), 1)


def _variant(params: dict, strategy: str, f: float) -> dict:
    out = dict(params)
    for p in bt.STRATEGIES[strategy]["params"]:
        if p["key"] in {"fast", "slow", "signal", "period", "entry", "exit", "lookback", "atr", "smooth"}:
            out[p["key"]] = min(max(round(params[p["key"]] * f), p["min"]), p["max"])
    return out


def fixes(cfg: AgentConfig, bars: list[dict], diag: dict, base: dict, profile: str | None) -> list[dict]:
    """Changes aimed at what went wrong, each re-run on the same bars and on the last 30% alone."""
    keys = {f["key"] for f in diag["findings"]}
    cand: list[tuple[str, str, dict]] = []
    atr = diag.get("median_atr_pct")
    if atr and ({"tight_stops", "many_stops", "volatility"} & keys or cfg.stop_loss_pct < atr):
        stop = max(round(atr * 1.5 * 2) / 2, 0.5)
        if stop > cfg.stop_loss_pct:
            cand.append((f"Wider stop of {stop}%", f"About 1.5 times gold's usual range, with the size cut so a stop-out "
                         f"costs the same as before.", {"stop_loss_pct": stop, "size_pct": cfg.size_pct * cfg.stop_loss_pct / stop}))
    if "shorts" in keys and cfg.direction != "long_only":
        cand.append(("Long trades only", "Skips the short trades that lost money in a rising market.", {"direction": "long_only"}))
    if "longs" in keys and cfg.direction != "short_only":
        cand.append(("Short trades only", "Skips the long trades that lost money in a falling market.", {"direction": "short_only"}))
    if {"regime", "against_trend", "streak", "costs"} & keys:
        slow = _variant(cfg.params, cfg.strategy, 2)
        if slow != cfg.params:
            cand.append(("Slower settings", "Doubles the strategy's lookback lengths, so it trades less and reacts to "
                         "bigger moves only.", {"params": slow}))
        fast = _variant(cfg.params, cfg.strategy, 0.5)
        if fast != cfg.params and "regime" in keys:
            cand.append(("Faster settings", "Halves the lookback lengths, so it reacts sooner.", {"params": fast}))
    if "profile" in keys and diag.get("fit"):
        ratios = [c["limit"] / c["value"] for c in diag["fit"]["checks"] if c["value"]]
        if ratios and min(ratios) < 1:
            cand.append(("Smaller positions", "Cuts the size until the results stay inside your risk limits.",
                         {"size_pct": cfg.size_pct * min(ratios) * 0.95}))
    # A different kind of strategy, if the market didn't suit this one.
    kind = bt.STRATEGIES[cfg.strategy]["kind"]
    if "regime" in keys or "against_trend" in keys:
        other = "reversion" if kind == "trend" else "trend"
        alts = []
        for key, spec in bt.STRATEGIES.items():
            if spec["kind"] != other:
                continue
            try:
                rep = bt.run(cfg.backtest(strategy=key, params={}), bars)
            except (ValueError, ValidationError):
                continue
            alts.append((_calmar(rep["stats"]), key))
        for _, key in sorted(alts, reverse=True)[:2]:
            cand.append((f"Switch to {bt.STRATEGIES[key]['label']}", f"A {bt.KINDS[other].lower()} strategy, which suits "
                         f"the markets this one struggled in, with its default settings.",
                         {"strategy": key, "params": {p["key"]: p["default"] for p in bt.STRATEGIES[key]["params"]}}))

    cut = int(len(bars) * (1 - HOLDOUT))
    late = bars[cut:]
    base_late = bt.run(cfg.backtest(), late) if len(late) > 30 else None
    out = []
    for title, why, change in cand:
        try:
            new = cfg.model_copy(update=change)
            new = AgentConfig(**new.model_dump())
            rep = bt.run(new.backtest(), bars)
        except (ValueError, ValidationError):
            continue
        s = _brief(rep)
        late_s = _brief(bt.run(new.backtest(), late)) if base_late else None
        out.append({
            "title": title, "why": why, "config": new.model_dump(), "stats": s,
            "better": _calmar(s) > _calmar(base),
            "late": late_s, "late_better": None if not late_s else _calmar(late_s) > _calmar(_brief(base_late)),
        })
    out.sort(key=lambda f: (f["better"], f["late_better"] or False, _calmar(f["stats"])), reverse=True)
    return out


# ---------------------------------------------------------------------------
# Past test
# ---------------------------------------------------------------------------


def _profile(user_id: int) -> str | None:
    p = profile_of(user_id)
    return p["profile"] if p else None


def past(body: PastIn, user_id: int) -> dict:
    start = date.today() - timedelta(days=round(body.years * 365.25))
    bars = bt.load_bars(body.tf, start, None)
    if len(bars) < 60:
        raise HTTPException(422, "Not enough price history for that period yet")
    cfg = AgentConfig(**body.model_dump(exclude={"years"}))
    rep = bt.run(cfg.backtest(), bars)
    profile = _profile(user_id)
    diag = diagnose(bars, rep["trades"], rep["equity"], cfg.strategy, cfg.stop_loss_pct, 10_000, profile)
    out = {
        "config": cfg.model_dump(), "years": body.years, "profile": profile,
        "period": rep["period"], "stats": rep["stats"], "equity": rep["equity"],
        "trades": rep["trades"][-200:], "diagnosis": diag,
        "fixes": fixes(cfg, bars, diag, _brief(rep), profile),
    }
    with db.conn() as c:
        c.execute("""INSERT INTO agent_analyses (user_id, result) VALUES (%s, %s)
                     ON CONFLICT (user_id) DO UPDATE SET result = EXCLUDED.result, created_at = now()""",
                  (user_id, Jsonb({k: v for k, v in out.items() if k not in ("equity", "trades")})))
    return out


# ---------------------------------------------------------------------------
# Live agent on the paper account
# ---------------------------------------------------------------------------


def _log(c, user_id: int, kind: str, message: str) -> None:
    c.execute("INSERT INTO paper_agent_log (user_id, kind, message) VALUES (%s, %s, %s)", (user_id, kind, message))


def _closed_bars(c, tf: str, now: datetime) -> list[dict]:
    rows = c.execute(
        """SELECT extract(epoch FROM ts)::bigint AS t, open AS o, high AS h, low AS l, close AS c FROM candles
           WHERE symbol = %s AND tf = %s ORDER BY ts DESC LIMIT %s""", (config.SYMBOL, tf, WARMUP_BARS + 1)).fetchall()
    rows.reverse()
    return [r for r in rows if r["t"] + TF_SECONDS[tf] <= now.timestamp()]


def step(user_id: int, now: datetime | None = None) -> bool:
    """Act on the newest closed bar if the agent hasn't yet. Returns True if it traded."""
    now = now or datetime.now(timezone.utc)
    with db.conn() as c:
        ag = c.execute("SELECT * FROM paper_agents WHERE user_id = %s AND status = 'running' FOR UPDATE", (user_id,)).fetchone()
        if not ag:
            return False
        cfg = AgentConfig(**ag["config"])
        acct, book, price = paper.sync(c, user_id)
        bars = _closed_bars(c, cfg.tf, now)
        if len(bars) < 60:
            if ag["note"] != "warmup":
                _log(c, user_id, "wait", "Waiting for enough price history to compute the strategy's signal.")
                c.execute("UPDATE paper_agents SET note = 'warmup' WHERE user_id = %s", (user_id,))
            return False
        last = datetime.fromtimestamp(bars[-1]["t"], timezone.utc)
        if ag["last_bar"] and last <= ag["last_bar"]:
            return False

        sig = bt.signals(cfg.strategy, cfg.params, bars)[-1]
        allow = {"both": (1, -1), "long_only": (1,), "short_only": (-1,)}[cfg.direction]
        want = sig if sig in allow else 0
        mine = c.execute("SELECT id FROM paper_positions WHERE user_id = %s AND agent AND closed_at IS NULL", (user_id,)).fetchone()
        pos = next((p for p in book.positions if mine and p["id"] == mine["id"]), None)
        blocked = ag["blocked"]
        if ag["position_id"] and not pos:
            # Our position was closed by its stop, target or a stop-out since the last bar. Like the
            # backtester, wait for the signal to change before re-entering the same side.
            gone = c.execute("SELECT side, close_reason, pnl FROM paper_positions WHERE id = %s", (ag["position_id"],)).fetchone()
            if gone and gone["close_reason"] != AGENT_KIND:
                side = 1 if gone["side"] == "long" else -1
                blocked = side if want == side else 0
                _log(c, user_id, "closed", f"The {gone['side']} position was closed by its {gone['close_reason'].replace('_', ' ')} "
                                           f"({'+' if gone['pnl'] >= 0 else '-'}${abs(gone['pnl']):,.2f}).")
        if blocked and want != blocked:
            blocked = 0
        if blocked:
            want = 0
        have = 0 if not pos else (1 if pos["side"] == "long" else -1)
        traded = False
        candle = last.strftime("%d %b %H:%M UTC") if cfg.tf == "1h" else last.strftime("%d %b %Y")
        label = bt.STRATEGIES[cfg.strategy]["label"]
        if have != want:
            if not price or not price["open"]:
                if ag["note"] != "closed":
                    _log(c, user_id, "wait", "The market is closed, so the agent will act when prices start moving again.")
                    c.execute("UPDATE paper_agents SET note = 'closed' WHERE user_id = %s", (user_id,))
                return False
            if pos:
                row = book.close(pos, paper._exit_price(pos["side"], price["bid"]), now, AGENT_KIND)
                _log(c, user_id, "close", f"Closed the {pos['side']} position at ${row['exit_price']:,.2f} because {label} "
                                          f"{'turned ' + ('long' if want == 1 else 'short') if want else 'went flat'} on the "
                                          f"{candle} candle ({'+' if row['pnl'] >= 0 else '-'}${abs(row['pnl']):,.2f}).")
                traded = True
            pid = None
            if want:
                side = "long" if want == 1 else "short"
                fill = price["ask"] if want == 1 else price["bid"]
                eq, used = book.equity(price["bid"], now)
                units = round(max(eq, 0) * cfg.size_pct / 100 / fill, 2)
                need = units * price["bid"] * book.rate
                if units <= 0 or used + need > eq:
                    _log(c, user_id, "skip", f"Wanted to go {side} but the account doesn't have enough free margin for "
                                             f"{units:,.2f} oz. Lower the size or raise the account's leverage.")
                else:
                    stop = round(fill * (1 - cfg.stop_loss_pct / 100) if want == 1 else fill * (1 + cfg.stop_loss_pct / 100), 2)
                    p = book.open(side, units, fill, now, stop, None, AGENT_KIND)
                    c.execute("UPDATE paper_positions SET agent = true WHERE id = %s", (p["id"],))
                    pid = p["id"]
                    _log(c, user_id, "open", f"Opened {side} {units:,.2f} oz at ${fill:,.2f} with a stop at ${stop:,.2f}, "
                                             f"because {label} turned {side} on the {candle} candle.")
                    traded = True
            c.execute("UPDATE paper_accounts SET balance = %s WHERE user_id = %s", (round(book.balance, 2), user_id))
        else:
            pid = pos["id"] if pos else None
            if ag["last_bar"] is None:
                _log(c, user_id, "check", f"Checked the {candle} candle: {label} is "
                                          f"{'long' if want == 1 else 'short' if want == -1 else 'flat'}"
                                          f"{', so it holds the position' if pos else ', so there is no trade yet' if not want else ''}.")
        c.execute("""UPDATE paper_agents SET last_bar = %s, signal = %s, blocked = %s, position_id = %s, note = ''
                     WHERE user_id = %s""", (last, sig, blocked, pid, user_id))
        return traded


def step_all() -> int:
    with db.conn() as c:
        users = [r["user_id"] for r in c.execute("SELECT user_id FROM paper_agents WHERE status = 'running'").fetchall()]
    n = 0
    for uid in users:
        try:
            n += step(uid)
        except Exception:
            log.exception("agent step failed for user %s", uid)
    return n


def live_report(user_id: int) -> dict | None:
    """The agent's own paper trades since it started, explained like a past test, next to a backtest
    of the same settings over the same days."""
    with db.conn() as c:
        ag = c.execute("SELECT * FROM paper_agents WHERE user_id = %s", (user_id,)).fetchone()
        if not ag:
            return None
        rows = c.execute(f"SELECT {paper.POS_COLS} FROM paper_positions WHERE user_id = %s AND agent "
                         "AND opened_at >= %s ORDER BY opened_at, id", (user_id, ag["started_at"])).fetchall()
        acct = paper._account(c, user_id)
    cfg = AgentConfig(**ag["config"])
    closed = [r for r in rows if r["closed_at"]]
    capital = acct["starting_balance"]
    trades, cash = [], capital
    equity = [(int(ag["started_at"].timestamp()), cash)]
    for r in closed:
        cash += r["pnl"]
        equity.append((int(r["closed_at"].timestamp()), cash))
        trades.append({"side": r["side"], "units": r["units"], "entry_time": int(r["opened_at"].timestamp()),
                       "entry_price": r["entry_price"], "exit_time": int(r["closed_at"].timestamp()),
                       "exit_price": r["exit_price"], "costs": round(paper.SPREAD * r["units"], 2), "swap": r["swap"],
                       "pnl": r["pnl"], "stop_loss": r["stop_loss"], "exit_reason": r["close_reason"]})
    rep = build_report(trades, equity, capital)
    start = ag["started_at"] - timedelta(seconds=TF_SECONDS[cfg.tf] * WARMUP_BARS)
    bars = bt.load_bars(cfg.tf, start.date(), None)
    live_bars = [b for b in bars if b["t"] >= ag["started_at"].timestamp() - TF_SECONDS[cfg.tf]]
    diag = diagnose(live_bars, trades, rep["equity"], cfg.strategy, cfg.stop_loss_pct, capital, _profile(user_id)) if closed else None
    # What the same settings did in a backtest over the agent's days, for comparison.
    compare = None
    if len(bars) > 60:
        try:
            full = bt.run(cfg.backtest(capital=capital), bars)
            since = ag["started_at"].timestamp()
            bt_trades = [t for t in full["trades"] if t["entry_time"] >= since]
            compare = {"trades": len(bt_trades), "pnl": round(sum(t["pnl"] for t in bt_trades), 2)}
        except ValueError:
            pass
    return {"stats": rep["stats"], "equity": rep["equity"], "trades": trades[-100:],
            "open": [r for r in rows if not r["closed_at"]], "diagnosis": diag, "backtest_same_days": compare}


def state(user_id: int) -> dict:
    step(user_id)  # the page also moves the agent along, so it works without the scheduler
    with db.conn() as c:
        ag = c.execute("SELECT * FROM paper_agents WHERE user_id = %s", (user_id,)).fetchone()
        log_rows = c.execute("SELECT ts, kind, message FROM paper_agent_log WHERE user_id = %s ORDER BY id DESC LIMIT 60",
                             (user_id,)).fetchall()
        last_past = c.execute("SELECT result, created_at FROM agent_analyses WHERE user_id = %s", (user_id,)).fetchone()
    out = {"agent": None, "log": log_rows, "live": None, "last_past_test": last_past, "price": paper.current_price()}
    if ag:
        cfg = AgentConfig(**ag["config"])
        out["agent"] = {**{k: ag[k] for k in ("status", "started_at", "stopped_at", "last_bar", "signal", "blocked")},
                        "config": cfg.model_dump(), "label": bt.STRATEGIES[cfg.strategy]["label"],
                        "next_check": (ag["last_bar"] + timedelta(seconds=2 * TF_SECONDS[cfg.tf])) if ag["last_bar"] else None}
        out["live"] = live_report(user_id)
    return out


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@router.post("/past")
def past_route(body: PastIn, user: UserOut = Depends(current_user)):
    return past(body, user.id)


@router.get("")
def get(user: UserOut = Depends(current_user)):
    return state(user.id)


@router.post("/start")
def start(cfg: AgentConfig, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        paper._account(c, user.id)
        old = c.execute("SELECT status FROM paper_agents WHERE user_id = %s", (user.id,)).fetchone()
        if old and old["status"] == "running":
            raise HTTPException(409, "The agent is already running. Stop it first to change its settings.")
        c.execute("""INSERT INTO paper_agents (user_id, config) VALUES (%s, %s)
                     ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, status = 'running', started_at = now(),
                       stopped_at = NULL, last_bar = NULL, signal = 0, blocked = 0, position_id = NULL, note = ''""",
                  (user.id, Jsonb(cfg.model_dump())))
        _log(c, user.id, "start", f"Started {bt.STRATEGIES[cfg.strategy]['label']} on "
                                  f"{'hourly' if cfg.tf == '1h' else 'daily'} candles, {cfg.size_pct:.0f}% of the account per "
                                  f"trade with a {cfg.stop_loss_pct}% stop.")
    return state(user.id)


class StopIn(BaseModel):
    close_position: bool = True


@router.post("/stop")
def stop(body: StopIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        ag = c.execute("SELECT * FROM paper_agents WHERE user_id = %s AND status = 'running' FOR UPDATE", (user.id,)).fetchone()
        if not ag:
            raise HTTPException(404, "The agent isn't running")
        msg = "Stopped the agent."
        if body.close_position:
            acct, book, price = paper.sync(c, user.id)
            mine = c.execute("SELECT id FROM paper_positions WHERE user_id = %s AND agent AND closed_at IS NULL", (user.id,)).fetchone()
            pos = next((p for p in book.positions if mine and p["id"] == mine["id"]), None)
            if pos and price and price["open"]:
                row = book.close(pos, paper._exit_price(pos["side"], price["bid"]), datetime.now(timezone.utc), AGENT_KIND)
                c.execute("UPDATE paper_accounts SET balance = %s WHERE user_id = %s", (round(book.balance, 2), user.id))
                msg = f"Stopped the agent and closed its {pos['side']} position ({'+' if row['pnl'] >= 0 else '-'}${abs(row['pnl']):,.2f})."
            elif pos:
                msg = "Stopped the agent. The market is closed, so its position stays open with its stop loss."
        c.execute("UPDATE paper_agents SET status = 'stopped', stopped_at = now() WHERE user_id = %s", (user.id,))
        _log(c, user.id, "stop", msg)
    return state(user.id)


class CoachIn(BaseModel):
    situation: str = Field("", max_length=1200)


COACH_PROMPT = (
    "Coach me on my strategy agent. Call my_agent to read its latest past test and its live paper results. "
    "Explain in plain English what went wrong and when (dates, the kind of market, events and headlines from that time), "
    "then which of the tested fixes improved the results, by how much, and whether they also held up on the last 30%. "
    "Finish with what I could watch for in the live run. Use only numbers from the tools.")


@router.post("/coach", status_code=202)
def coach(body: CoachIn, tasks: BackgroundTasks, user: UserOut = Depends(current_user)):
    from . import assistant

    q = COACH_PROMPT
    if body.situation.strip():
        q += f"\n\nAlso, my situation or question: {body.situation.strip()}"
    return assistant.ask(assistant.AskIn(question=q), tasks, user)

