"""A review of each closed paper trade that grades the decision, not the result.

The facts come from the trade itself and the prices around it: was there a stop, how much of the
account it risked, the planned reward against the risk, the trend and RSI when it was opened, any
big release nearby, and how it ended. A checklist turns those into a grade. When the AI assistant is
set up, Claude writes the review from the same facts; otherwise the checklist's own words are used.

A good trade can lose money and a poor one can win. Nothing here predicts prices or is advice."""

import json
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb

from . import config, db
from .auth import UserOut, current_user
from .risk import profile_of

router = APIRouter(prefix="/practice/reviews", tags=["practice"])

AI_DAILY_LIMIT = 30
GRADES = ["A", "B", "C", "D"]

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "grade": {"type": "string", "enum": GRADES},
        "headline": {"type": "string"},
        "went_well": {"type": "array", "items": {"type": "string"}},
        "work_on": {"type": "array", "items": {"type": "string"}},
        "next_time": {"type": "string"},
    },
    "required": ["grade", "headline", "went_well", "work_on", "next_time"],
    "additionalProperties": False,
}

SYSTEM = """You are a calm, encouraging trading coach on GoldLab, a site where people practise trading gold
(XAU/USD) and other markets with virtual money. You review ONE closed practice trade from the facts you are given.

Grade the DECISION PROCESS, never the profit or loss: a well-planned trade that lost can earn an A, a
reckless trade that won can earn a D. The checklist grade in the facts is a starting point; move it by
at most one letter, and only for a reason you state.

Write in plain, friendly English for a beginner. Use the numbers in the facts; do not invent any. Give a
one-sentence headline, one to three things that went well, one to three things to work on (or none if
there is truly nothing), and one concrete habit for next time. Each item is one short sentence.

Never say where gold will go next, never recommend buying or selling now, and never give financial
advice. This is education about process only."""


def _rsi(closes: list[float], n: int = 14) -> float | None:
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for a, b in zip(closes[-n - 1:-1], closes[-n:]):
        d = b - a
        gains += max(d, 0)
        losses += max(-d, 0)
    if losses == 0:
        return 100.0
    rs = gains / losses
    return round(100 - 100 / (1 + rs), 1)


def facts(c, user_id: int, p: dict) -> dict:
    """Everything the review is based on, worked out from the trade and the prices around it."""
    entry, exit_, units, long = p["entry_price"], p["exit_price"], p["units"], p["side"] == "long"
    prior = c.execute("SELECT coalesce(sum(pnl), 0) AS s FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL "
                      "AND closed_at <= %s AND id <> %s", (user_id, p["opened_at"], p["id"])).fetchone()["s"]
    acct = c.execute("SELECT starting_balance FROM paper_accounts WHERE user_id = %s", (user_id,)).fetchone()
    equity = (acct["starting_balance"] if acct else 10_000.0) + prior
    risk = abs(entry - p["stop_loss"]) * units if p["stop_loss"] else None
    reward = abs(p["take_profit"] - entry) * units if p["take_profit"] else None
    profile = profile_of(user_id)
    limit = profile["max_risk_per_trade_pct"] if profile else 1.0

    bars = c.execute("SELECT close, high, low FROM candles WHERE symbol = %s AND tf = '1h' AND ts < %s "
                     "ORDER BY ts DESC LIMIT 60", (p.get("symbol") or config.SYMBOL, p["opened_at"])).fetchall()[::-1]
    closes = [b["close"] for b in bars]
    trend = None
    if len(closes) >= 50:
        s20, s50 = sum(closes[-20:]) / 20, sum(closes[-50:]) / 50
        trend = "up" if s20 > s50 and closes[-1] > s20 else "down" if s20 < s50 and closes[-1] < s20 else "mixed"
    hi20 = max((b["high"] for b in bars[-20:]), default=None)
    lo20 = min((b["low"] for b in bars[-20:]), default=None)
    events = c.execute("SELECT title, ts FROM events WHERE impact = 'High' AND ts BETWEEN %s AND %s ORDER BY ts",
                       (p["opened_at"] - timedelta(hours=3), p["opened_at"] + timedelta(hours=3))).fetchall()
    held = (p["closed_at"] - p["opened_at"]).total_seconds()
    return {
        "side": p["side"], "ounces": units, "entry": round(entry, 2), "exit": round(exit_, 2),
        "stop_loss": p["stop_loss"], "take_profit": p["take_profit"], "order_type": p["order_kind"],
        "how_it_ended": {"stop_loss": "hit its stop loss", "take_profit": "hit its take profit", "manual": "closed by hand",
                         "stop_out": "closed by a margin stop-out", "agent": "closed by the strategy agent"}.get(
                             p["close_reason"] or "", p["close_reason"] or "closed"),
        "profit_or_loss": round(p["pnl"] or 0, 2),
        "held_minutes": round(held / 60),
        "account_before": round(equity, 2),
        "risked": round(risk, 2) if risk is not None else None,
        "risked_pct": round(risk / equity * 100, 2) if risk is not None and equity > 0 else None,
        "risk_limit_pct": limit,
        "planned_reward_to_risk": round(reward / risk, 2) if risk and reward else None,
        "result_in_r": round((p["pnl"] or 0) / risk, 2) if risk else None,
        "trend_before_entry": trend,
        "rsi_before_entry": _rsi(closes),
        "entry_vs_20h_range": (None if hi20 is None or hi20 == lo20 else
                               round((entry - lo20) / (hi20 - lo20) * 100)),
        "with_trend": None if trend in (None, "mixed") else (trend == "up") == long,
        "big_release_within_3h": [e["title"] for e in events],
    }


def checklist(f: dict) -> tuple[str, list[str], list[str], str]:
    """A plain scoring of the process. Returns grade, good points, points to work on, and a habit."""
    good, work, score = [], [], 0
    if f["stop_loss"]:
        score += 2
        good.append("You set a stop loss before the trade, so the most you could lose was decided in advance.")
    else:
        work.append("There was no stop loss, so the loss had no limit until you acted.")
    if f["risked_pct"] is not None:
        if f["risked_pct"] <= f["risk_limit_pct"] + 0.05:
            score += 2
            good.append(f"It risked {f['risked_pct']}% of the account, inside your {f['risk_limit_pct']}% limit.")
        else:
            work.append(f"It risked {f['risked_pct']}% of the account, above your {f['risk_limit_pct']}% limit.")
    if f["planned_reward_to_risk"] is not None:
        if f["planned_reward_to_risk"] >= 1.5:
            score += 1
            good.append(f"The target was {f['planned_reward_to_risk']} times the risk, so wins can pay for losses.")
        elif f["planned_reward_to_risk"] < 1:
            work.append(f"The target was only {f['planned_reward_to_risk']} times the risk.")
    if f["how_it_ended"] == "closed by a margin stop-out":
        score -= 2
        work.append("The broker's stop-out closed it, which means the position was too big for the account.")
    if f["with_trend"] is True:
        score += 1
        good.append(f"It went with the {f['trend_before_entry']} trend on the hourly chart.")
    elif f["with_trend"] is False:
        work.append(f"It went against the {f['trend_before_entry']} trend on the hourly chart; that can work, but needs a clear reason.")
    if f["big_release_within_3h"]:
        work.append(f"It opened close to {f['big_release_within_3h'][0]}, when prices can jump past stops.")
    grade = "A" if score >= 5 else "B" if score >= 3 else "C" if score >= 1 else "D"
    habit = ("Before each trade, write down the stop, the target and the reason in one line."
             if not f["stop_loss"] or f["planned_reward_to_risk"] is None
             else "Keep sizing every trade from its stop, so each loss costs about the same.")
    return grade, good[:3], work[:3], habit


def _headline(grade: str, f: dict) -> str:
    won = f["profit_or_loss"] >= 0
    return {
        "A": "A well-planned trade" + (" that paid off." if won else ", even though this one lost."),
        "B": "A solid plan with one or two things to tighten.",
        "C": "Some good instincts, but the plan had gaps" + (" (this time it still made money)." if won else "."),
        "D": "This one was more gamble than plan" + (", whatever the result." if won else "."),
    }[grade]


def _ai(f: dict, grade: str) -> dict | None:
    if not config.ANTHROPIC_API_KEY:
        return None
    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=2)
    try:
        resp = client.beta.messages.create(
            model=config.ASSISTANT_MODEL,
            max_tokens=2000,
            system=SYSTEM,
            messages=[{"role": "user", "content": "Review this closed practice trade.\n\n" +
                       json.dumps({**f, "checklist_grade": grade}, default=str)}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": REVIEW_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.APIError:
        return None
    if resp.stop_reason in ("refusal", "max_tokens"):
        return None
    try:
        out = json.loads(next(b.text for b in resp.content if b.type == "text"))
    except (StopIteration, ValueError):
        return None
    if out.get("grade") not in GRADES:
        return None
    return out


def review(user_id: int, pid: int) -> dict:
    with db.conn() as c:
        p = c.execute("SELECT * FROM paper_positions WHERE id = %s AND user_id = %s", (pid, user_id)).fetchone()
        if not p:
            raise HTTPException(404, "No such trade")
        if p["closed_at"] is None:
            raise HTTPException(409, "Close the trade first; reviews are for finished trades")
        have = c.execute("SELECT review, source, created_at FROM trade_reviews WHERE position_id = %s", (pid,)).fetchone()
        if have:
            return {**have["review"], "source": have["source"], "created_at": have["created_at"]}
        f = facts(c, user_id, p)
        used = c.execute("SELECT count(*) AS n FROM trade_reviews WHERE user_id = %s AND source = 'ai' "
                         "AND created_at > now() - interval '1 day'", (user_id,)).fetchone()["n"]
    grade, good, work, habit = checklist(f)
    out = _ai(f, grade) if used < AI_DAILY_LIMIT else None
    source = "ai" if out else "checklist"
    if not out:
        out = {"grade": grade, "headline": _headline(grade, f), "went_well": good, "work_on": work, "next_time": habit}
    out = {**out, "checklist_grade": grade, "facts": f}
    with db.conn() as c:
        row = c.execute(
            "INSERT INTO trade_reviews (position_id, user_id, review, source) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (position_id) DO UPDATE SET position_id = EXCLUDED.position_id RETURNING review, source, created_at",
            (pid, user_id, Jsonb(json.loads(json.dumps(out, default=str))), source),
        ).fetchone()
    return {**row["review"], "source": row["source"], "created_at": row["created_at"]}


@router.post("/{pid}")
def create(pid: int, user: UserOut = Depends(current_user)):
    return review(user.id, pid)


@router.get("")
def grades(user: UserOut = Depends(current_user)):
    """Grades already given, by trade, so the history list can show them."""
    with db.conn() as c:
        rows = c.execute("SELECT position_id, review->>'grade' AS grade FROM trade_reviews WHERE user_id = %s",
                         (user.id,)).fetchall()
    return {str(r["position_id"]): r["grade"] for r in rows}
