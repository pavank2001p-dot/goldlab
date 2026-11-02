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

from . import backtest, calendar, config, db, fit, news, prices, risk
from .auth import UserOut, current_user
from .trades import log_report

log = logging.getLogger("assistant")
router = APIRouter(prefix="/assistant", tags=["assistant"])

MAX_TURNS = 8  # model calls per question
MAX_SECONDS = 120
MAX_HISTORY = 10

SYSTEM = """You are the GoldLab assistant, built into an educational website about gold (XAU/USD) trading.

What you do
- Explain gold prices, strategies, backtests, risk and news in plain English for people who may be new to trading.
- Help users understand their own backtests, trade log and risk profile.

Rules you always follow
- Every price, return, statistic or date you state must come from a tool result in this conversation. If you need a number, call a tool. If no tool can give it, say you don't have that data. Never estimate prices from memory.
- This is education, not advice. Never tell the user to buy, sell, enter or exit a trade, never predict where the price will go, and never say a strategy will make money. You may explain what past data shows, what a risk limit means, and what a trader would weigh.
- When results come from backtests, remind the user that past results don't guarantee future ones, in a few words, once.
- If price_summary says the data source is "sample", tell the user the prices are demo data, not real market prices.
- When suggesting a trade size, base it on the user's risk profile limits and the profile_fit tool, and present it as what would have stayed within their own limits.
- Keep answers short: a few sentences or a short list. Use the user's currency (USD) and say "ounces" for size.
- If asked about something unrelated to gold, markets or this site, say briefly that you can only help with those topics."""

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


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
        "daily closes. Data starts in 2010.",
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
        "name": "run_backtest",
        "description": "Run a backtest on stored gold prices and return its statistics (not saved). Fills at the "
        "next bar's open and charges spread and overnight swap. Settings not given use the defaults.",
        "input_schema": _obj({
            "strategy": {"type": "string", "enum": list(backtest.STRATEGIES)},
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


def t_price_history(i: dict, user_id: int) -> dict:
    bars = _daily_closes(_date(i["start"]), _date(i.get("end")))
    if not bars:
        return {"error": "No prices in that range. Data starts in 2010."}
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


def t_run_backtest(i: dict, user_id: int) -> dict:
    cfg = backtest.BacktestIn(**{k: v for k, v in i.items() if v is not None})
    rep = backtest.run(cfg, backtest.load_bars(cfg.tf, cfg.start, cfg.end))
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


HANDLERS = {
    "price_summary": t_price_summary,
    "price_history": t_price_history,
    "list_strategies": t_list_strategies,
    "run_backtest": t_run_backtest,
    "my_backtests": t_my_backtests,
    "my_trade_log": t_my_trade_log,
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


def process(qid: int) -> None:
    with db.conn() as c:
        row = c.execute("SELECT user_id, question, history FROM assistant_questions WHERE id = %s", (qid,)).fetchone()
    status, text, used = "error", "Something went wrong answering that. It hasn't counted toward your daily limit.", []
    try:
        client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=3)
        text, used = answer(client, row["user_id"], row["question"], row["history"])
        status = "done"
    except anthropic.APIError as e:
        log.warning("assistant request failed: %s", e)
    except Exception:
        log.exception("assistant failed")
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
