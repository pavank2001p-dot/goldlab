"""The Lab home: one loop through the whole app, a level earned from process, and where you left off.

Every session is a lap of the same five stages: Spark (an idea from a lesson or a question), Build (a
strategy of your own), Test (a backtest or the agent's diagnosis), Play (paper, replay, challenges) and
Review (a trade review, a note in the journal, the coach's weekly report). A lap is counted when the
stages happen in that order, so nothing extra is stored: it is all worked out from what the user did.

XP rewards process, never profit. It comes from setting limits, finishing lessons, building and testing
ideas, trading with a stop inside the limit, reviewing trades, writing things down and finishing laps."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from . import db, learn
from .achievements import compute as badges_of
from .auth import UserOut, current_user
from .practice import week_of
from .risk import profile_of

router = APIRouter(prefix="/lab", tags=["lab"])

STAGES = ["spark", "build", "test", "play", "review"]

STAGE_INFO = {
    "spark": ("Spark", "Find an idea worth testing: a lesson from gold's history, a headline, or a question."),
    "build": ("Build", "Turn the idea into rules of your own in the strategy studio."),
    "test": ("Test", "See how those rules would have done on past prices, with real costs."),
    "play": ("Play", "Trade it with virtual money: paper, a replayed day or a challenge."),
    "review": ("Review", "Look back at the decision, not the result, and write down what you learned."),
}

# XP for each kind of process step, and the most of each that counts, so no single habit can be farmed.
XP = {
    "limits": (50, 1),
    "lesson": (30, 50),
    "strategy": (40, 10),
    "backtest": (10, 30),
    "stop_trade": (15, 40),
    "inside_trade": (10, 40),
    "review": (20, 40),
    "note": (10, 40),
    "weekly": (30, 52),
    "prop": (40, 10),
    "badge": (25, 20),
    "lap": (100, 50),
}

XP_LABELS = {
    "limits": "Risk limits set",
    "lesson": "Lessons finished",
    "strategy": "Strategies built",
    "backtest": "Backtests run",
    "stop_trade": "Paper trades with a stop",
    "inside_trade": "Paper trades inside your limit",
    "review": "Trades reviewed",
    "note": "Journal notes",
    "weekly": "Weekly challenges played",
    "prop": "Prop challenges finished",
    "badge": "Habit badges",
    "lap": "Laps of the loop",
}

LEVELS = [
    (0, "Apprentice", "Learning the tools and the habits."),
    (300, "Analyst", "Tests ideas before trusting them."),
    (900, "Strategist", "Builds, tests and reviews in a steady loop."),
    (2000, "Market-ready", "Keeps the process under pressure, lap after lap."),
]


def laps(events: list[tuple[datetime, str]]) -> tuple[int, int, list[datetime | None]]:
    """Walk the user's activity in time order. A stage counts when it comes after the one before it;
    after Review the lap is done and the next one starts at Spark. Returns finished laps, the stage the
    current lap is waiting on (0 to 4), and when each stage of the current lap was done (None if not yet)."""
    done, at, cur = 0, 0, [None] * len(STAGES)
    for ts, stage in sorted(events, key=lambda e: e[0]):
        if stage == STAGES[at]:
            cur[at] = ts
            at += 1
            if at == len(STAGES):
                done, at, cur = done + 1, 0, [None] * len(STAGES)
    return done, at, cur


def level_of(xp: int) -> dict:
    i = max(i for i, (floor, _, _) in enumerate(LEVELS) if xp >= floor)
    floor, name, blurb = LEVELS[i]
    nxt = LEVELS[i + 1] if i + 1 < len(LEVELS) else None
    return {"rank": i + 1, "name": name, "blurb": blurb, "floor": floor,
            "next": {"name": nxt[1], "at": nxt[0]} if nxt else None}


def _ago(ts: datetime, now: datetime) -> str:
    s = (now - ts).total_seconds()
    if s < 3600:
        return "just now" if s < 120 else f"{int(s // 60)} minutes ago"
    if s < 86400:
        h = int(s // 3600)
        return f"{h} hour{'s' if h > 1 else ''} ago"
    d = int(s // 86400)
    return "yesterday" if d == 1 else f"{d} days ago"


def compute(user_id: int, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    profile = profile_of(user_id)
    with db.conn() as c:
        q = lambda sql: c.execute(sql, (user_id,)).fetchall()  # noqa: E731
        lessons = q("SELECT lesson, completed_at AS ts FROM lesson_progress WHERE user_id = %s")
        asks = q("SELECT created_at AS ts FROM assistant_questions WHERE user_id = %s AND status <> 'error' "
                 "ORDER BY created_at DESC LIMIT 200")
        strategies = q("SELECT id, rules, updated_at AS ts FROM custom_strategies WHERE user_id = %s ORDER BY updated_at DESC")
        tests = q("SELECT created_at AS ts FROM backtests WHERE user_id = %s ORDER BY created_at DESC LIMIT 500")
        diagnosed = q("SELECT created_at AS ts FROM agent_analyses WHERE user_id = %s")
        positions = q("SELECT id, stop_loss, entry_price, units, opened_at AS ts, closed_at FROM paper_positions "
                      "WHERE user_id = %s AND order_kind <> 'agent' ORDER BY opened_at DESC LIMIT 500")
        weekly = q("SELECT week, created_at AS ts FROM challenge_entries WHERE user_id = %s")
        props = q("SELECT status, plan, phase, started_at AS ts, ended_at FROM prop_challenges WHERE user_id = %s "
                  "ORDER BY started_at DESC")
        reviews = q("SELECT position_id, created_at AS ts FROM trade_reviews WHERE user_id = %s")
        notes = q("SELECT created_at AS ts FROM trades WHERE user_id = %s AND btrim(notes) <> ''")
        coach = q("SELECT created_at AS ts FROM coach_reports WHERE user_id = %s")
        account = c.execute("SELECT starting_balance FROM paper_accounts WHERE user_id = %s", (user_id,)).fetchone()

    events: list[tuple[datetime, str]] = []
    events += [(r["ts"], "spark") for r in lessons + asks]
    events += [(r["ts"], "build") for r in strategies]
    events += [(r["ts"], "test") for r in tests + diagnosed]
    events += [(r["ts"], "play") for r in positions + weekly + props]
    events += [(r["ts"], "review") for r in reviews + notes + coach]
    finished, at, current = laps(events)

    # XP, from process only.
    cap = account["starting_balance"] * profile["max_risk_per_trade_pct"] / 100 if profile and account else None
    stopped = [p for p in positions if p["stop_loss"] is not None]
    inside = [p for p in stopped if cap is not None and abs(p["entry_price"] - p["stop_loss"]) * p["units"] <= cap + 1e-9]
    habits = badges_of(user_id, now)
    counts = {
        "limits": 1 if profile else 0,
        "lesson": len(lessons),
        "strategy": len(strategies),
        "backtest": len(tests),
        "stop_trade": len(stopped),
        "inside_trade": len(inside),
        "review": len(reviews),
        "note": len(notes),
        "weekly": len(weekly),
        "prop": sum(1 for p in props if p["status"] in ("passed", "failed")),
        "badge": habits["earned"],
        "lap": finished,
    }
    sources = []
    xp = 0
    for key, (each, most) in XP.items():
        n = min(counts[key], most)
        xp += n * each
        sources.append({"key": key, "label": XP_LABELS[key], "count": counts[key], "each": each, "xp": n * each})

    # What to do next in the current lap, made specific from what the user already has.
    done_lessons = {r["lesson"] for r in lessons}
    next_lesson = next((ls for ls in learn.LESSONS if ls["id"] not in done_lessons), None)
    latest = strategies[0] if strategies else None
    latest_name = (latest["rules"] or {}).get("name", "your strategy") if latest else None
    active_prop = next((p for p in props if p["status"] == "active"), None)
    this_week = week_of(now.date())
    played_weekly = any(w["week"] == this_week for w in weekly)
    reviewed = {r["position_id"] for r in reviews}
    unreviewed = [p for p in positions if p["closed_at"] is not None and p["id"] not in reviewed]

    def action(stage: str) -> dict:
        if stage == "spark":
            if next_lesson:
                return {"title": f"Read “{next_lesson['title']}”",
                        "detail": f"A {next_lesson['minutes']}-minute story from {next_lesson['year']}, then trade that week.",
                        "href": f"/learn/{next_lesson['id']}", "cta": "Start the lesson"}
            return {"title": "Ask the assistant what is moving gold",
                    "detail": "Pick one driver from the answer and turn it into a rule.",
                    "href": "/assistant", "cta": "Ask a question"}
        if stage == "build":
            if latest:
                return {"title": f"Sharpen “{latest_name}”",
                        "detail": "Change one rule for the idea you just found, and watch the preview update.",
                        "href": f"/strategies/builder?id={latest['id']}", "cta": "Open the studio"}
            return {"title": "Build your first strategy",
                    "detail": "Start from a template, change one rule, and see the trades on the chart.",
                    "href": "/strategies/builder", "cta": "Open the studio"}
        if stage == "test":
            return {"title": "Test it on 20 years of prices" if latest else "Backtest an idea",
                    "detail": "Real spreads and swaps, a check on the last 30% alone, and a fit against your limits.",
                    "href": "/backtest", "cta": "Run a backtest"}
        if stage == "play":
            if active_prop:
                return {"title": f"Continue your {active_prop['plan']} prop challenge",
                        "detail": f"Phase {active_prop['phase']} is running. Every trade is checked against its loss limits.",
                        "href": "/paper/prop", "cta": "Back to the challenge"}
            if not played_weekly:
                return {"title": "Play this week's challenge",
                        "detail": "The same stretch of history for everyone. One go, candle by candle.",
                        "href": "/paper/challenge", "cta": "Play the challenge"}
            return {"title": "Place a paper trade with a stop",
                    "detail": "Decide where you would be wrong before you enter, and size from it.",
                    "href": "/paper", "cta": "Open paper trading"}
        if unreviewed:
            n = len(unreviewed)
            return {"title": f"Review your last trade{'s' if n > 1 else ''}",
                    "detail": f"{n} closed trade{'s are' if n > 1 else ' is'} waiting for a grade on the decision, not the result.",
                    "href": "/paper#history", "cta": "Review trades"}
        return {"title": "Read your coach report",
                "detail": "Mistake tags from your own trades and one thing to keep doing.",
                "href": "/coach", "cta": "Open the coach"}

    if not profile:
        mission = {"stage": "limits", "title": "Set your risk limits first",
                   "detail": "A 17-question quiz sets how much you are willing to lose per trade. Every page checks against it.",
                   "href": "/risk", "cta": "Take the risk quiz", "xp": XP["limits"][0]}
    else:
        stage = STAGES[at]
        xp_for = {"spark": XP["lesson"][0], "build": XP["strategy"][0], "test": XP["backtest"][0],
                  "play": XP["stop_trade"][0] + XP["inside_trade"][0], "review": XP["review"][0] + XP["lap"][0]}
        mission = {"stage": stage, **action(stage), "xp": xp_for[stage]}

    stages = []
    for i, key in enumerate(STAGES):
        name, blurb = STAGE_INFO[key]
        state = "done" if current[i] else "current" if i == at and profile else "todo"
        stages.append({"key": key, "name": name, "blurb": blurb, "state": state,
                       "done_at": current[i].isoformat() if current[i] else None, **action(key)})

    # Where you left off: things that are still open, newest first.
    resume = []
    open_trades = [p for p in positions if p["closed_at"] is None]
    if open_trades:
        n = len(open_trades)
        resume.append({"title": f"{n} open paper trade{'s' if n > 1 else ''}",
                       "detail": f"Opened {_ago(open_trades[0]['ts'], now)}", "href": "/paper", "ts": open_trades[0]["ts"]})
    if active_prop:
        resume.append({"title": f"{active_prop['plan'].capitalize()} prop challenge, phase {active_prop['phase']}",
                       "detail": f"Started {_ago(active_prop['ts'], now)}", "href": "/paper/prop", "ts": active_prop["ts"]})
    if latest:
        resume.append({"title": f"Strategy: {latest_name}", "detail": f"Edited {_ago(latest['ts'], now)}",
                       "href": f"/strategies/builder?id={latest['id']}", "ts": latest["ts"]})
    if tests:
        resume.append({"title": "Your latest backtest", "detail": f"Run {_ago(tests[0]['ts'], now)}",
                       "href": "/backtest", "ts": tests[0]["ts"]})
    if lessons and next_lesson:
        last = max(lessons, key=lambda r: r["ts"])
        resume.append({"title": f"Next lesson: {next_lesson['title']}",
                       "detail": f"{len(done_lessons)} of {len(learn.LESSONS)} done, last {_ago(last['ts'], now)}",
                       "href": f"/learn/{next_lesson['id']}", "ts": last["ts"]})
    resume.sort(key=lambda r: r["ts"], reverse=True)
    for r in resume:
        r["ts"] = r["ts"].isoformat()

    week_ago = now - timedelta(days=7)
    return {
        "xp": xp,
        "level": level_of(xp),
        "sources": sources,
        "laps": finished,
        "stage": at,
        "stages": stages,
        "mission": mission,
        "resume": resume[:3],
        "active_days_this_week": len({ts.date() for ts, _ in events if ts >= week_ago}),
    }


@router.get("")
def get(user: UserOut = Depends(current_user)):
    return compute(user.id)
