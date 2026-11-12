"""AI assistant: answers questions about gold and the user's own results with Claude.

Every number in an answer must come from a tool that reads the site's data (prices, backtests,
the trade log, news, the calendar), never from the model's memory. Answers run in the background;
the page polls for them. Each user gets ASSISTANT_DAILY_LIMIT questions per UTC day.
"""

import json
import logging
import time
from datetime import date, datetime, timedelta, timezone
from typing import Literal

import anthropic
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, ValidationError, model_validator

from . import backtest, calendar, config, custom, db, fit, news, paper, prices, risk
from .auth import UserOut, current_user
from .trades import log_report

log = logging.getLogger("assistant")
router = APIRouter(prefix="/assistant", tags=["assistant"])

MAX_TURNS = 12  # model calls per question; building a strategy takes a few test-and-adjust rounds
MAX_SECONDS = 150
MAX_HISTORY = 10

SYSTEM = """You are the Trading Lab assistant, built into an educational trading website. You focus on gold (XAU/USD).

What you do
- Explain gold prices, strategies, backtests, risk and news in plain English for people who may be new to trading.
- Help users understand their own backtests, trade log, paper trading account and risk profile.

Rules you always follow
- Every price, return, statistic or date you state must come from a tool result in this conversation. If you need a number, call a tool. If no tool can give it, say you don't have that data. Never estimate prices from memory.
- This is education, not advice. Never tell the user to buy, sell, enter or exit a trade, never predict where the price will go, and never say a strategy will make money. You may explain what past data shows, what a risk limit means, and what a trader would weigh.
- When results come from backtests, remind the user that past results don't guarantee future ones, in a few words, once.
- If price_summary says the data source is "sample", tell the user the prices are demo data, not real market prices.
- When suggesting a trade size, base it on the user's risk profile limits and the profile_fit tool, and present it as what would have stayed within their own limits.
- When asked what went wrong with a strategy or how to handle a situation, use diagnose_strategy or my_agent. Explain the findings with their dates and the kind of market at the time, and present fixes only as changes that were tested on past prices with the results the tool gave, including whether they held up on the last 30%. Say that a fix that helped in the past may not help in future.
- Keep answers short: a few sentences or a short list. Use the user's currency (USD) and say "ounces" for size.
- When asked to build, design or invent a strategy, write it yourself as rules with test_rules, which tests it on past prices without saving it. You may adjust and re-test a few times (at most about four versions), judging each version on the earlier 70% of the period and then checking it held up on the last 30%; don't tune to the last 30%. Then save the version you'll describe with save_strategy and give the link it returns as a markdown link, e.g. [Open it in the builder](/strategies/builder?id=12). Describe the rules in plain words, show the test results (including the last 30% and buy and hold), and say if it did worse than simply holding gold. Build with what the rules can express; if the idea needs something else (volume, news, other markets, time of day), say what you left out. Update an existing saved strategy only when the user asks for that one to be changed.
- If asked about something unrelated to gold, markets or this site, say briefly that you can only help with those topics."""

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


_OPERAND = {
    "type": "object",
    "properties": {
        "ind": {"type": "string", "enum": list(custom.INDICATORS)},
        "n": {"type": "number", "description": "First setting (length or bars); omit for the default"},
        "m": {"type": "number", "description": "Second setting, where the indicator has one"},
        "value": {"type": "number", "description": "Only for ind = value: the fixed number"},
    },
    "required": ["ind"],
    "additionalProperties": False,
}
_CONDS = {"type": "array", "maxItems": custom.MAX_CONDITIONS, "items": _obj(
    {"left": _OPERAND, "op": {"type": "string", "enum": list(custom.OPS)}, "right": _OPERAND}, ["left", "op", "right"])}
RULES_SCHEMA = _obj({"name": {"type": "string", "description": "Short name, under 40 characters"},
                     "long_entry": _CONDS, "long_exit": _CONDS, "short_entry": _CONDS, "short_exit": _CONDS}, ["name"])
RULES_HELP = f"""How rules work: four lists of conditions (long_entry, long_exit, short_entry, short_exit); every condition in a
list must hold on a candle's close for it to fire, and the trade fills at the next open. An entry on the other side also
closes a position, so exits are optional, and at least one entry list is needed. A condition is left op right, op one of
{', '.join(custom.OPS)} (crosses_above: left was at or below right on the previous candle and is above it now). The left
operand can't be a plain number. "highest" and "lowest" look at the previous n candles, not the current one.
Indicators (ind):
{custom.catalogue_text()}"""

TOOLS = [
    {
        "name": "price_summary",
        "description": "Latest XAU/USD price, 24-hour change, returns over 1 week, 1 month, 3 months, 1 year and "
        "year to date, the 52-week high and low, average daily range, and where the data comes from.",
        "input_schema": _obj({}),
    },
    {
        "name": "price_history",
        "description": "Gold prices between two dates: open, close, high, low, return, and up to 60 evenly spaced "
        "daily closes. Daily data starts in 2003; for earlier dates (back to 1833) it returns monthly prices "
        "instead.",
        "input_schema": _obj({
            "start": {"type": "string", "format": "date", "description": "YYYY-MM-DD"},
            "end": {"type": "string", "format": "date", "description": "YYYY-MM-DD, exclusive; omit for today"},
        }, ["start"]),
    },
    {
        "name": "list_strategies",
        "description": "The backtest strategies available and their settings, with defaults and allowed ranges.",
        "input_schema": _obj({}),
    },
    {
        "name": "my_custom_strategies",
        "description": "The custom strategies this user built and saved: id, name and their rules in plain words.",
        "input_schema": _obj({}),
    },
    {
        "name": "run_backtest",
        "description": "Run a backtest on stored gold prices and return its statistics (not saved). Fills at the "
        "next bar's open and charges spread and overnight swap. Settings not given use the defaults.",
        "input_schema": _obj({
            "strategy": {"type": "string", "enum": list(backtest.STRATEGIES)},
            "custom_id": {"type": "integer", "description": "Run one of the user's saved custom strategies (id from "
                          "my_custom_strategies) instead of a built-in one; strategy and params are then ignored"},
            "params": {"type": "object", "description": "Strategy settings by key, from list_strategies",
                       "additionalProperties": {"type": "number"}},
            "tf": {"type": "string", "enum": ["1h", "1d"], "description": "Bar size; default 1d"},
            "start": {"type": "string", "format": "date"},
            "end": {"type": "string", "format": "date"},
            "direction": {"type": "string", "enum": ["both", "long_only", "short_only"]},
            "capital": {"type": "number", "description": "Starting balance in USD; default 10000"},
            "units": {"type": "number", "description": "Ounces per trade; default 5"},
            "stop_loss_pct": {"type": "number"},
            "take_profit_pct": {"type": "number"},
        }, ["strategy"]),
    },
    {
        "name": "my_backtests",
        "description": "The user's 10 most recent saved backtests: id, settings and key statistics.",
        "input_schema": _obj({}),
    },
    {
        "name": "my_trade_log",
        "description": "Statistics for the user's own logged gold trades and the 20 most recent closed trades.",
        "input_schema": _obj({"capital": {"type": "number", "description": "Account size in USD; default 10000"}}),
    },
    {
        "name": "my_paper_account",
        "description": "The user's paper trading (practice, virtual money) account: balance, equity, open positions, "
        "pending orders, statistics and the 20 most recent closed paper trades. Read-only: you cannot place or close trades.",
        "input_schema": _obj({}),
    },
    {
        "name": "my_risk_profile",
        "description": "The user's risk profile from the quiz (conservative, moderate or aggressive) and its limits.",
        "input_schema": _obj({}),
    },
    {
        "name": "profile_fit",
        "description": "Check a saved backtest, or the user's trade log, against the limits of their risk profile. "
        "Returns each check, an overall verdict and a trade size that would have stayed inside the limits.",
        "input_schema": _obj({
            "backtest_id": {"type": "integer", "description": "A saved backtest id; omit to check the trade log"},
            "capital": {"type": "number", "description": "Trade log only: account size in USD; default 10000"},
        }),
    },
    {
        "name": "gold_news",
        "description": "Recent news headlines that mention gold or its drivers, each tagged bullish, bearish or "
        "neutral for gold with a one-line reason.",
        "input_schema": _obj({"limit": {"type": "integer", "description": "Up to 30; default 10"}}),
    },
    {
        "name": "my_agent",
        "description": "The user's paper-trading strategy agent: its settings, whether it is running, its recent actions, "
        "its live paper results with an explanation of what went wrong, and the latest past test with its diagnosis "
        "(findings with dates, the worst period with events and headlines, and fixes tested on the same prices).",
        "input_schema": _obj({}),
    },
    {
        "name": "diagnose_strategy",
        "description": "Backtest a strategy over the last N years and explain what went wrong: losses by kind of market "
        "(uptrend, downtrend, sideways), direction, stops against volatility, costs, losing streaks, the worst drawdown "
        "with the Fed and inflation dates and gold headlines from then, plus fixes re-tested on the same prices and on "
        "the last 30% alone. Trades are sized as a % of the account.",
        "input_schema": _obj({
            "strategy": {"type": "string", "enum": [k for k in backtest.STRATEGIES if k != "buy_and_hold"]},
            "custom_id": {"type": "integer", "description": "Run one of the user's saved custom strategies (id from "
                          "my_custom_strategies) instead of a built-in one; strategy and params are then ignored"},
            "params": {"type": "object", "additionalProperties": {"type": "number"}},
            "tf": {"type": "string", "enum": ["1h", "1d"]},
            "direction": {"type": "string", "enum": ["both", "long_only", "short_only"]},
            "stop_loss_pct": {"type": "number", "description": "Default 3"},
            "size_pct": {"type": "number", "description": "Position value as % of the account; default 33"},
            "years": {"type": "number", "description": "How far back to test; default 5"},
        }, ["strategy"]),
    },
    {
        "name": "test_rules",
        "description": "Test a strategy you write yourself as rules, on past gold prices, without saving it. Returns the "
        "rules in plain words and results for the whole period, the earlier 70% and the last 30% alone (unseen when "
        "judging the earlier part), with buy and hold over the same days. Each trade uses the whole account (no "
        "leverage) unless size_pct is set.\n\n" + RULES_HELP,
        "input_schema": _obj({
            "rules": RULES_SCHEMA,
            "tf": {"type": "string", "enum": ["1h", "1d"], "description": "Bar size; default 1d"},
            "years": {"type": "number", "description": "How far back to test, 0.5 to 25; default 10 on 1d, 2 on 1h"},
            "direction": {"type": "string", "enum": ["both", "long_only", "short_only"]},
            "stop_loss_pct": {"type": "number", "description": "Stop loss as % of entry price; default none"},
            "take_profit_pct": {"type": "number"},
            "size_pct": {"type": "number", "description": "Position value as % of the account; default 100"},
        }, ["rules"]),
    },
    {
        "name": "save_strategy",
        "description": "Save rules to the user's strategy library, where they can open them in the strategy builder, "
        "backtest them, and run them as the paper-trading agent. Returns the saved id and links. Give replace_id only "
        "when the user asked to change that saved strategy.",
        "input_schema": _obj({
            "rules": RULES_SCHEMA,
            "replace_id": {"type": "integer", "description": "Id of the user's saved strategy to overwrite"},
        }, ["rules"]),
    },
    {
        "name": "economic_calendar",
        "description": "Upcoming US economic events that often move gold (Fed meetings, inflation, jobs), with "
        "why each matters.",
        "input_schema": _obj({"days": {"type": "integer", "description": "Days ahead, up to 30; default 14"}}),
    },
]


def _daily_closes(start: datetime | None = None, end: datetime | None = None) -> list[dict]:
    sql = "SELECT extract(epoch FROM ts)::bigint AS t, open AS o, high AS h, low AS l, close AS c FROM candles WHERE symbol = %s AND tf = '1d'"
    args: list = [config.SYMBOL]
    if start:
        sql += " AND ts >= %s"
        args.append(start)
    if end:
        sql += " AND ts < %s"
        args.append(end)
    with db.conn() as c:
        return c.execute(sql + " ORDER BY ts", args).fetchall()


def _day(t: int) -> str:
    return datetime.fromtimestamp(t, timezone.utc).date().isoformat()


def _pct(a: float, b: float) -> float:
    return round((b / a - 1) * 100, 2)


def t_price_summary(_: dict, user_id: int) -> dict:
    s = prices.summary()
    if s.get("price") is None:
        return {"error": "No price data is loaded yet."}
    year_ago = datetime.now(timezone.utc) - timedelta(days=400)
    bars = _daily_closes(year_ago)
    out = {
        "price": round(s["price"], 2),
        "as_of": datetime.fromtimestamp(s["as_of"], timezone.utc).isoformat(timespec="minutes"),
        "change_24h": None if s["change_24h"] is None else round(s["change_24h"], 2),
        "change_24h_pct": None if s["change_24h_pct"] is None else round(s["change_24h_pct"], 2),
        "data_source": s["source"],
        "data_starts": _day(s["first_bar"]),
    }
    if bars:
        last, now_t = bars[-1]["c"], bars[-1]["t"]

        def back(days: int):
            cutoff = now_t - days * 86400
            older = [b for b in bars if b["t"] <= cutoff]
            return _pct(older[-1]["c"], last) if older else None

        jan1 = datetime(datetime.now(timezone.utc).year, 1, 1, tzinfo=timezone.utc).timestamp()
        ytd = [b for b in bars if b["t"] < jan1]
        year = [b for b in bars if b["t"] > now_t - 365 * 86400]
        recent = bars[-15:]
        out.update({
            "return_1w_pct": back(7), "return_1m_pct": back(30), "return_3m_pct": back(91), "return_1y_pct": back(365),
            "return_ytd_pct": _pct(ytd[-1]["c"], last) if ytd else None,
            "high_52w": round(max(b["h"] for b in year), 2), "low_52w": round(min(b["l"] for b in year), 2),
            "avg_daily_range_14d": round(sum(b["h"] - b["l"] for b in recent[1:]) / max(len(recent) - 1, 1), 2),
        })
    return out


def _date(v: str | None) -> datetime | None:
    if not v:
        return None
    d = date.fromisoformat(v)
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def _monthly(start: datetime | None, end: datetime | None) -> list[dict]:
    sql = "SELECT extract(epoch FROM ts)::bigint AS t, open AS o, high AS h, low AS l, close AS c FROM candles WHERE symbol = %s AND tf = '1mo'"
    args: list = [config.SYMBOL]
    if start:
        sql += " AND ts >= %s"
        args.append(start)
    if end:
        sql += " AND ts < %s"
        args.append(end)
    with db.conn() as c:
        return c.execute(sql + " ORDER BY ts", args).fetchall()


def t_price_history(i: dict, user_id: int) -> dict:
    start, end = _date(i["start"]), _date(i.get("end"))
    bars = _daily_closes(start, end)
    if not bars or (start and bars[0]["t"] - start.timestamp() > 45 * 86400):
        # The range starts before the daily data: use monthly prices (annual averages before 1960).
        months = _monthly(start, end)
        if months:
            step = max(1, len(months) // 60)
            return {
                "resolution": "monthly averages (one value per year before 1960), no daily highs or lows",
                "first_month": _day(months[0]["t"])[:7], "last_month": _day(months[-1]["t"])[:7],
                "first_price": round(months[0]["c"], 2), "last_price": round(months[-1]["c"], 2),
                "return_pct": _pct(months[0]["c"], months[-1]["c"]),
                "high": round(max(m["c"] for m in months), 2), "low": round(min(m["c"] for m in months), 2),
                "prices": [[_day(m["t"])[:7], round(m["c"], 2)] for m in months[::step]],
            }
    if not bars:
        return {"error": "No prices in that range. Monthly prices start in 1833."}
    step = max(1, len(bars) // 60)
    hi = max(bars, key=lambda b: b["h"])
    lo = min(bars, key=lambda b: b["l"])
    return {
        "first_day": _day(bars[0]["t"]), "last_day": _day(bars[-1]["t"]), "trading_days": len(bars),
        "open": round(bars[0]["o"], 2), "close": round(bars[-1]["c"], 2), "return_pct": _pct(bars[0]["o"], bars[-1]["c"]),
        "high": round(hi["h"], 2), "high_day": _day(hi["t"]), "low": round(lo["l"], 2), "low_day": _day(lo["t"]),
        "closes": [[_day(b["t"]), round(b["c"], 2)] for b in bars[::step]],
    }


def t_list_strategies(_: dict, user_id: int) -> list:
    return backtest.strategies()


def _with_custom(i: dict, user_id: int) -> dict:
    """Swap a custom_id for the saved rules, checking the strategy belongs to this user."""
    i = {k: v for k, v in i.items() if v is not None}
    sid = i.pop("custom_id", None)
    if sid is not None:
        i.update(strategy="custom", params={}, rules=custom.owned(user_id, int(sid)))
    return i


def t_my_custom_strategies(_: dict, user_id: int) -> list:
    return [{"id": r["id"], "name": r["name"], "rules": r["description"]} for r in custom.saved(user_id)]


def t_run_backtest(i: dict, user_id: int) -> dict:
    cfg = backtest.BacktestIn(**_with_custom(i, user_id))
    rep = backtest.run(cfg, backtest.load_bars(cfg.tf, cfg.start, cfg.end, cfg.symbol))
    return {"settings": cfg.model_dump(mode="json"), "stats": rep["stats"],
            "period": {"start": _day(rep["period"]["start"]), "end": _day(rep["period"]["end"])}}


def t_my_backtests(_: dict, user_id: int) -> list:
    with db.conn() as c:
        rows = c.execute(
            "SELECT id, created_at, params, stats FROM backtests WHERE user_id = %s ORDER BY created_at DESC LIMIT 10",
            (user_id,),
        ).fetchall()
    keep = ("net_profit", "total_return_pct", "cagr_pct", "max_drawdown_pct", "sharpe", "trades", "win_rate_pct",
            "profit_factor", "buy_and_hold_pct", "wiped_out")
    return [{"id": r["id"], "created": r["created_at"].date().isoformat(), "settings": r["params"],
             "stats": {k: r["stats"].get(k) for k in keep}} for r in rows]


def t_my_trade_log(i: dict, user_id: int) -> dict:
    rep = log_report(user_id, i.get("capital") or 10_000)
    if not rep["stats"]["trades"]:
        return {"error": "The user hasn't logged any closed trades yet."}
    trades = [{**t, "entry_time": _day(t["entry_time"]), "exit_time": _day(t["exit_time"])} for t in rep["trades"][-20:]]
    return {"stats": rep["stats"], "recent_trades": trades}


def t_my_paper_account(_: dict, user_id: int) -> dict:
    s = paper.summary(user_id)
    rep = paper.paper_report(user_id)
    pos_keys = ("side", "units", "entry_price", "stop_loss", "take_profit", "mark", "pnl")
    ord_keys = ("side", "kind", "units", "price", "stop_loss", "take_profit")
    return {
        "account": {k: v for k, v in s["account"].items() if k != "created_at"},
        "price": s["price"] and {k: s["price"][k] for k in ("bid", "ask", "open")},
        "open_positions": [{k: p[k] for k in pos_keys} for p in s["positions"]],
        "pending_orders": [{k: o[k] for k in ord_keys} for o in s["orders"]],
        "stats": rep["stats"],
        "recent_closed": [{**t, "entry_time": _day(t["entry_time"]), "exit_time": _day(t["exit_time"])}
                          for t in rep["trades"][-20:]],
        "settings": s["settings"],
    }


def t_my_risk_profile(_: dict, user_id: int) -> dict:
    p = risk.profile_of(user_id)
    if not p:
        return {"error": "The user hasn't taken the risk quiz yet. It's on the Risk quiz page."}
    return {k: p[k] for k in ("profile", "label", "summary", "max_risk_per_trade_pct", "max_drawdown_pct", "max_leverage")}


def t_profile_fit(i: dict, user_id: int) -> dict:
    try:
        if i.get("backtest_id"):
            return fit.for_backtest(user_id, i["backtest_id"])
        return fit.for_trade_log(user_id, i.get("capital") or 10_000)
    except HTTPException as e:
        return {"error": e.detail}


def t_gold_news(i: dict, user_id: int) -> dict:
    feed = news.list_(limit=min(int(i.get("limit") or 10), 30), gold_only=False)
    if not feed["items"]:
        return {"error": "No news is loaded yet."}
    return {"items": [{"published": r["published_at"].isoformat(timespec="minutes"), "headline": r["headline"],
                       "publisher": r["publisher"], "impact_on_gold": r["impact"], "reason": r["reason"]}
                      for r in feed["items"]]}


def t_economic_calendar(i: dict, user_id: int) -> list:
    rows = calendar.list_(days=min(int(i.get("days") or 14), 30), past_days=0)
    return [{"time_utc": r["ts"].isoformat(timespec="minutes"), "event": r["title"], "impact": r["impact"],
             "forecast": r["forecast"], "previous": r["previous"], "why_it_matters": r["why"]} for r in rows]


def t_my_agent(_: dict, user_id: int) -> dict:
    from . import agent

    s = agent.state(user_id)
    live = s["live"]
    if live:
        live = {k: live[k] for k in ("stats", "diagnosis", "backtest_same_days")} | {"recent_trades": live["trades"][-10:]}
    return {"agent": s["agent"], "recent_actions": s["log"][:15], "live": live,
            "latest_past_test": s["last_past_test"]}


def t_diagnose_strategy(i: dict, user_id: int) -> dict:
    from . import agent

    body = agent.PastIn(**_with_custom(i, user_id))
    out = agent.past(body, user_id)
    return {k: out[k] for k in ("config", "years", "period", "diagnosis", "fixes")} | {
        "stats": {k: out["stats"].get(k) for k in ("total_return_pct", "cagr_pct", "max_drawdown_pct", "trades",
                                                   "win_rate_pct", "profit_factor", "buy_and_hold_pct")}}


TEST_YEARS = {"1d": 10, "1h": 2}
IN_SAMPLE = 0.7


def _brief(stats: dict) -> dict:
    return {k: stats.get(k) for k in ("total_return_pct", "cagr_pct", "max_drawdown_pct", "sharpe", "trades",
                                      "win_rate_pct", "profit_factor", "buy_and_hold_pct", "time_in_market_pct", "wiped_out")}


def t_test_rules(i: dict, user_id: int) -> dict:
    rules = custom.Rules(**i["rules"])
    tf = i.get("tf") or "1d"
    years = min(max(float(i.get("years") or TEST_YEARS[tf]), 0.5), 25)
    start = date.today() - timedelta(days=round(years * 365.25))
    cfg = backtest.BacktestIn(strategy="custom", rules=rules, tf=tf, start=start, capital=10_000,
                              size_pct=i.get("size_pct") or 100, direction=i.get("direction") or "both",
                              stop_loss_pct=i.get("stop_loss_pct"), take_profit_pct=i.get("take_profit_pct"))
    bars = backtest.load_bars(tf, start, None)
    if len(bars) < 100:
        return {"error": "Not enough price history for that period."}
    cut = int(len(bars) * IN_SAMPLE)
    whole = backtest.run(cfg, bars)
    parts = {}
    for label, part in (("earlier_70pct", bars[:cut]), ("last_30pct", bars[cut:])):
        r = backtest.run(cfg, part)
        parts[label] = {"start": _day(part[0]["t"]), "end": _day(part[-1]["t"]), **_brief(r["stats"])}
    return {"rules_in_words": custom.describe(rules), "rules": rules.model_dump(),
            "settings": {"tf": tf, "years": years, "direction": cfg.direction, "size_pct": cfg.size_pct,
                         "stop_loss_pct": cfg.stop_loss_pct, "take_profit_pct": cfg.take_profit_pct},
            "whole_period": {"start": _day(bars[0]["t"]), "end": _day(bars[-1]["t"]), **_brief(whole["stats"])},
            **parts}


def t_save_strategy(i: dict, user_id: int) -> dict:
    rules = custom.Rules(**i["rules"])
    row = custom.save(user_id, rules, i.get("replace_id"))
    sid = row["id"]
    return {"id": sid, "name": row["name"], "rules_in_words": row["description"],
            "replaced": i.get("replace_id") is not None,
            "links": {"builder": f"/strategies/builder?id={sid}", "backtest": f"/backtest?custom={sid}",
                      "agent": f"/paper/agent?custom={sid}"}}


HANDLERS = {
    "test_rules": t_test_rules,
    "save_strategy": t_save_strategy,
    "my_agent": t_my_agent,
    "diagnose_strategy": t_diagnose_strategy,
    "price_summary": t_price_summary,
    "price_history": t_price_history,
    "list_strategies": t_list_strategies,
    "my_custom_strategies": t_my_custom_strategies,
    "run_backtest": t_run_backtest,
    "my_backtests": t_my_backtests,
    "my_trade_log": t_my_trade_log,
    "my_paper_account": t_my_paper_account,
    "my_risk_profile": t_my_risk_profile,
    "profile_fit": t_profile_fit,
    "gold_news": t_gold_news,
    "economic_calendar": t_economic_calendar,
}


def call_tool(name: str, args: dict, user_id: int) -> tuple[str, bool]:
    """Returns (JSON result, is_error). Bad input comes back to the model as an error it can fix."""
    handler = HANDLERS.get(name)
    if not handler:
        return f"Unknown tool {name}", True
    try:
        return json.dumps(handler(args, user_id), default=str), False
    except (ValidationError, ValueError, KeyError, TypeError) as e:
        return f"Invalid input: {e}", True
    except HTTPException as e:
        return str(e.detail), True
    except Exception:
        # One broken lookup shouldn't sink the whole answer: the model is told and can work around it.
        log.exception("assistant tool %s failed", name)
        return f"The {name} tool failed unexpectedly. Tell the user this lookup isn't working right now.", True


# ---------------------------------------------------------------------------
# The question loop
# ---------------------------------------------------------------------------


def answer(client: anthropic.Anthropic, user_id: int, question: str, history: list[dict]) -> tuple[str, list[str]]:
    messages = [*history, {"role": "user", "content": question}]
    used: list[str] = []
    started = time.monotonic()
    for _ in range(MAX_TURNS):
        resp = client.beta.messages.create(
            model=config.ASSISTANT_MODEL,
            max_tokens=8000,
            system=SYSTEM,
            tools=TOOLS,
            messages=messages,
            thinking={"type": "adaptive"},
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            return "Sorry, I can't help with that one. I can answer questions about gold, strategies and your results.", used
        calls = [b for b in resp.content if b.type == "tool_use"]
        if resp.stop_reason != "tool_use" or not calls:
            text = "\n\n".join(b.text for b in resp.content if b.type == "text").strip()
            if resp.stop_reason == "max_tokens":
                text += "\n\n(The answer was cut short. Try a narrower question.)"
            return text or "I couldn't put an answer together. Try rephrasing the question.", used
        if time.monotonic() - started > MAX_SECONDS:
            break
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for b in calls:
            used.append(b.name)
            content, is_error = call_tool(b.name, b.input, user_id)
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": content, "is_error": is_error})
        messages.append({"role": "user", "content": results})
    return "That question needed more steps than I can take at once. Try splitting it into smaller questions.", used


NOT_COUNTED = "It hasn't counted toward your daily limit."


def failure_text(e: Exception) -> str:
    """What to tell the user when a question fails: the likely cause, so it can be fixed, without internals."""
    msg = str(getattr(e, "message", "") or e).lower()
    if isinstance(e, anthropic.AuthenticationError):
        why = "The AI service rejected the site's API key, so the site owner needs to update ANTHROPIC_API_KEY."
    elif isinstance(e, anthropic.PermissionDeniedError):
        why = "The site's API key isn't allowed to use this AI model. The site owner needs to check its permissions."
    elif "credit balance" in msg or "billing" in msg:
        why = "The site's AI account is out of credit, so the site owner needs to top it up."
    elif isinstance(e, anthropic.NotFoundError):
        why = f"The AI model set for the assistant ({config.ASSISTANT_MODEL}) wasn't found. The site owner needs to check ASSISTANT_MODEL."
    elif isinstance(e, anthropic.RateLimitError):
        why = "The AI service is getting too many requests right now. Try again in a minute."
    elif isinstance(e, (anthropic.APIConnectionError, anthropic.InternalServerError)) or (
            isinstance(e, anthropic.APIStatusError) and e.status_code >= 500):
        why = "The AI service didn't respond properly. Try again in a minute."
    elif isinstance(e, anthropic.BadRequestError):
        why = "The AI service rejected the request. The details are in the server log."
    else:
        why = "Something went wrong answering that. The details are in the server log."
    return f"{why} {NOT_COUNTED}"


def process(qid: int) -> None:
    with db.conn() as c:
        row = c.execute("SELECT user_id, question, history FROM assistant_questions WHERE id = %s", (qid,)).fetchone()
    status, text, used = "error", f"Something went wrong answering that. {NOT_COUNTED}", []
    try:
        client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=3)
        text, used = answer(client, row["user_id"], row["question"], row["history"])
        status = "done"
    except anthropic.APIError as e:
        log.error("assistant request failed (question %s): %r", qid, e)
        text = failure_text(e)
    except Exception as e:
        log.exception("assistant failed (question %s)", qid)
        text = failure_text(e)
    with db.conn() as c:
        c.execute(
            "UPDATE assistant_questions SET status = %s, answer = %s, tools_used = %s, finished_at = now() WHERE id = %s",
            (status, text, Jsonb(used), qid),
        )


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default=[], max_length=MAX_HISTORY)

    @model_validator(mode="after")
    def _check(self):
        for i, t in enumerate(self.history):
            if t.role != ("user" if i % 2 == 0 else "assistant"):
                raise ValueError("History must alternate user and assistant turns, starting with the user")
        if len(self.history) % 2:
            raise ValueError("History must end with an assistant turn")
        return self


def _used_today(user_id: int) -> int:
    midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    with db.conn() as c:
        return c.execute(
            "SELECT count(*) AS n FROM assistant_questions WHERE user_id = %s AND created_at >= %s AND status <> 'error'",
            (user_id, midnight),
        ).fetchone()["n"]


@router.get("/status")
def status(user: UserOut = Depends(current_user)):
    used = _used_today(user.id)
    return {"configured": bool(config.ANTHROPIC_API_KEY), "limit": config.ASSISTANT_DAILY_LIMIT,
            "used_today": used, "remaining": max(config.ASSISTANT_DAILY_LIMIT - used, 0)}


@router.post("/questions", status_code=202)
def ask(body: AskIn, tasks: BackgroundTasks, user: UserOut = Depends(current_user)):
    if not config.ANTHROPIC_API_KEY:
        raise HTTPException(503, "The assistant isn't switched on yet")
    with db.conn() as c:
        # Serialise this user's requests so two quick clicks can't both slip under the limit.
        c.execute("SELECT pg_advisory_xact_lock(%s)", (user.id,))
        # An answer cut off by a restart would otherwise block the user forever.
        c.execute(
            """UPDATE assistant_questions SET status = 'error', finished_at = now()
               WHERE user_id = %s AND status = 'pending' AND created_at < now() - interval '5 minutes'""",
            (user.id,),
        )
        if _used_today(user.id) >= config.ASSISTANT_DAILY_LIMIT:
            raise HTTPException(429, f"You've used all {config.ASSISTANT_DAILY_LIMIT} questions for today. "
                                     "The limit resets at midnight UTC.")
        if c.execute("SELECT 1 FROM assistant_questions WHERE user_id = %s AND status = 'pending'", (user.id,)).fetchone():
            raise HTTPException(409, "Please wait for the current answer first")
        row = c.execute(
            "INSERT INTO assistant_questions (user_id, question, history) VALUES (%s, %s, %s) RETURNING id",
            (user.id, body.question.strip(), Jsonb([t.model_dump() for t in body.history])),
        ).fetchone()
    tasks.add_task(process, row["id"])
    return {"id": row["id"], "status": "pending"}


@router.get("/questions/{qid}")
def get(qid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        row = c.execute(
            "SELECT id, question, status, answer, tools_used, created_at FROM assistant_questions WHERE id = %s AND user_id = %s",
            (qid, user.id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Question not found")
    return row
