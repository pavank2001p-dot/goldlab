"""Badges for disciplined habits, and a journal streak.

Badges reward process, never profit: setting limits, testing before trading, using a stop,
sizing inside your limit, keeping a steady pace and writing things down. A badge's progress
is worked out from what the user has already done, so nothing extra is stored."""

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from . import db
from .auth import UserOut, current_user
from .risk import profile_of

router = APIRouter(prefix="/achievements", tags=["achievements"])

STOP_RUN = 10      # recent manual paper trades that must all carry a stop
LIMIT_RUN = 10     # recent manual paper trades that must all risk no more than the profile allows
PACE_TRADES = 5    # paper trades needed before the pace badge can count
PACE_PER_DAY = 5   # most new paper trades on any one day in the last 30 days
JOURNAL_NOTES = 5  # logged trades with a written note
STREAK_DAYS = 7


def _run(items: list[bool]) -> int:
    """How many of the newest items in a row are True (items are newest first)."""
    n = 0
    for ok in items:
        if not ok:
            break
        n += 1
    return n


def streaks(days: set[date], today: date) -> tuple[int, int]:
    """Current and best run of consecutive days. Today without an entry yet doesn't break the run."""
    best = run = 0
    prev = None
    for d in sorted(days):
        run = run + 1 if prev is not None and d - prev == timedelta(days=1) else 1
        best = max(best, run)
        prev = d
    cur, d = 0, today if today in days else today - timedelta(days=1)
    while d in days:
        cur += 1
        d -= timedelta(days=1)
    return cur, best


def badge(key: str, title: str, blurb: str, icon: str, progress: float, goal: float, earned: bool | None = None) -> dict:
    return {"key": key, "title": title, "blurb": blurb, "icon": icon, "progress": min(progress, goal), "goal": goal,
            "earned": progress >= goal if earned is None else earned}


def compute(user_id: int, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    profile = profile_of(user_id)
    with db.conn() as c:
        tests = c.execute("SELECT count(*) AS n FROM backtests WHERE user_id = %s", (user_id,)).fetchone()["n"]
        own = c.execute("SELECT count(*) AS n FROM custom_strategies WHERE user_id = %s", (user_id,)).fetchone()["n"]
        start = c.execute("SELECT starting_balance FROM paper_accounts WHERE user_id = %s", (user_id,)).fetchone()
        pos = c.execute(
            "SELECT side, units, entry_price, stop_loss, opened_at FROM paper_positions "
            "WHERE user_id = %s AND order_kind <> 'agent' ORDER BY opened_at DESC, id DESC",
            (user_id,),
        ).fetchall()
        logged = c.execute("SELECT notes, created_at FROM trades WHERE user_id = %s", (user_id,)).fetchall()

    stopped = [p["stop_loss"] is not None for p in pos]
    if profile and start:
        cap = start["starting_balance"] * profile["max_risk_per_trade_pct"] / 100
        inside = [p["stop_loss"] is not None and abs(p["entry_price"] - p["stop_loss"]) * p["units"] <= cap + 1e-9 for p in pos]
    else:
        inside = []
    since = now - timedelta(days=30)
    per_day: dict[date, int] = {}
    for p in pos:
        if p["opened_at"] >= since:
            per_day[p["opened_at"].date()] = per_day.get(p["opened_at"].date(), 0) + 1
    busiest = max(per_day.values(), default=0)
    notes = sum(1 for t in logged if t["notes"].strip())
    current, best = streaks({t["created_at"].astimezone(timezone.utc).date() for t in logged}, now.date())

    limit = f"{profile['max_risk_per_trade_pct']:g}%" if profile else "your limit"
    badges = [
        badge("limits", "Know your limits", "Take the risk quiz so every page can check against your limits.", "risk",
              1 if profile else 0, 1),
        badge("tested", "Test before you trust", "Backtest three ideas on past prices before trading any of them.", "backtest",
              tests, 3),
        badge("own_rules", "Your own rules", "Build and save a strategy of your own in the studio.", "bolt", own, 1),
        badge("stops", "Always a stop", f"Place a stop loss on {STOP_RUN} paper trades in a row.", "drop",
              _run(stopped), STOP_RUN),
        badge("inside", "Inside your limit",
              f"Risk no more than {limit} of the account on {LIMIT_RUN} paper trades in a row.", "scale",
              _run(inside), LIMIT_RUN),
        badge("pace", "Steady pace",
              f"Make {PACE_TRADES} paper trades without opening more than {PACE_PER_DAY} on any day this month.", "clock",
              len(pos), PACE_TRADES, earned=len(pos) >= PACE_TRADES and busiest <= PACE_PER_DAY),
        badge("notes", "Write it down", f"Add a note to {JOURNAL_NOTES} trades in your trade log.", "trades",
              notes, JOURNAL_NOTES),
        badge("streak", "A week of reflection", f"Log trades on {STREAK_DAYS} days in a row.", "calendar",
              best, STREAK_DAYS),
    ]
    return {
        "badges": badges,
        "earned": sum(b["earned"] for b in badges),
        "streak": {"current": current, "best": best, "logged_today": now.date() in {t["created_at"].astimezone(timezone.utc).date() for t in logged}},
    }


@router.get("")
def get(user: UserOut = Depends(current_user)):
    return compute(user.id)
