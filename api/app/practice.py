"""Practice extras: price alerts, habits insights from closed trades, and replay challenges.

Replay: a past stretch of candles is revealed one bar at a time and the user trades it. Entries
and manual exits fill at the close of the bar on screen; stops and targets are checked against
each later bar's high and low, the stop first when both are touched. There is no spread, so a
replay result is about decisions rather than costs.

The weekly challenge is the same replay on one stretch for everyone that week. The browser sends
its trades and the server settles them again from the candles, so the leaderboard only shows
results the prices support. Joining the leaderboard is opt-in, under a nickname.

Nothing here predicts prices or is advice; it is practice with virtual money."""

import hashlib
import random
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from . import config, db, prices
from .auth import UserOut, current_user
from .paper import current_price
from .trades import pnl as journal_pnl

router = APIRouter(prefix="/practice", tags=["practice"])

MAX_ALERTS = 25
REPLAY_BALANCE = 10_000.0
REPLAY_LEVERAGE = 20
CHALLENGE_RISK_PCT = 2.0   # most of the balance one challenge trade may put at risk
CONTEXT_BARS = 48          # bars shown before the replay starts, so there is something to read
MAX_REPLAY_BARS = 600
NICK = re.compile(r"^[A-Za-z0-9 _.-]{3,20}$")


def _r(x: float | None, n: int = 2) -> float | None:
    return None if x is None else round(x, n)


# ---------------------------------------------------------------------------
# Price alerts
# ---------------------------------------------------------------------------

class AlertIn(BaseModel):
    price: float = Field(gt=0, lt=100_000)
    note: str = Field("", max_length=120)


ALERT_COLS = "id, price, direction, note, created_at, triggered_at, triggered_price"


@router.get("/alerts")
def alerts(user: UserOut = Depends(current_user)):
    with db.conn() as c:
        return c.execute(
            f"SELECT {ALERT_COLS} FROM price_alerts WHERE user_id = %s "
            "ORDER BY triggered_at IS NOT NULL, triggered_at DESC, price DESC LIMIT 100",
            (user.id,),
        ).fetchall()


@router.post("/alerts", status_code=201)
def add_alert(body: AlertIn, user: UserOut = Depends(current_user)):
    price = current_price()
    if not price:
        raise HTTPException(503, "No price yet, so there is nothing to compare the alert with")
    if abs(body.price - price["bid"]) < 0.01:
        raise HTTPException(422, "That is the price right now. Pick a level above or below it.")
    direction = "above" if body.price > price["bid"] else "below"
    with db.conn() as c:
        n = c.execute("SELECT count(*) AS n FROM price_alerts WHERE user_id = %s AND triggered_at IS NULL",
                      (user.id,)).fetchone()["n"]
        if n >= MAX_ALERTS:
            raise HTTPException(422, f"You can keep up to {MAX_ALERTS} waiting alerts. Remove one first.")
        return c.execute(
            f"INSERT INTO price_alerts (user_id, price, direction, note) VALUES (%s, %s, %s, %s) RETURNING {ALERT_COLS}",
            (user.id, round(body.price, 2), direction, body.note.strip()),
        ).fetchone()


@router.delete("/alerts/{aid}", status_code=204)
def delete_alert(aid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        c.execute("DELETE FROM price_alerts WHERE id = %s AND user_id = %s", (aid, user.id))


@router.post("/alerts/check")
def check_alerts(user: UserOut = Depends(current_user)):
    """Marks waiting alerts the price has reached since they were set, and returns them.

    Uses the highest and lowest prices since each alert was made, so an alert is not missed
    while the site was closed."""
    price = current_price()
    if not price:
        return {"triggered": [], "price": None}
    with db.conn() as c:
        waiting = c.execute(
            "SELECT id, price, direction, created_at FROM price_alerts WHERE user_id = %s AND triggered_at IS NULL",
            (user.id,),
        ).fetchall()
        hit = []
        for a in waiting:
            rng = c.execute(
                "SELECT max(high) AS h, min(low) AS l FROM candles WHERE symbol = %s AND tf = '1m' "
                "AND ts >= date_trunc('minute', %s::timestamptz)",
                (config.SYMBOL, a["created_at"]),
            ).fetchone()
            hi = max(x for x in (rng["h"], price["bid"]) if x is not None)
            lo = min(x for x in (rng["l"], price["bid"]) if x is not None)
            if (a["direction"] == "above" and hi >= a["price"]) or (a["direction"] == "below" and lo <= a["price"]):
                hit.append(a["id"])
        rows = []
        if hit:
            rows = c.execute(
                f"UPDATE price_alerts SET triggered_at = now(), triggered_price = %s WHERE id = ANY(%s) RETURNING {ALERT_COLS}",
                (price["bid"], hit),
            ).fetchall()
    return {"triggered": rows, "price": price["bid"]}


# ---------------------------------------------------------------------------
# Insights: patterns in how someone trades, from their closed trades
# ---------------------------------------------------------------------------

QUICK_REENTRY_MIN = 30
MIN_TRADES = 5


def _paper_trades(c, user_id: int) -> list[dict]:
    rows = c.execute(
        "SELECT side, units, entry_price, opened_at, closed_at, stop_loss, pnl FROM paper_positions "
        "WHERE user_id = %s AND closed_at IS NOT NULL ORDER BY opened_at",
        (user_id,),
    ).fetchall()
    return [{"side": r["side"], "units": r["units"], "open": r["opened_at"], "close": r["closed_at"],
             "stop": r["stop_loss"], "pnl": r["pnl"] or 0.0} for r in rows]


def _journal_trades(c, user_id: int) -> list[dict]:
    rows = c.execute(
        "SELECT side, units, open_time, open_price, close_time, close_price, stop_loss, fees, swap FROM trades "
        "WHERE user_id = %s AND close_time IS NOT NULL ORDER BY open_time",
        (user_id,),
    ).fetchall()
    return [{"side": r["side"], "units": r["units"], "open": r["open_time"], "close": r["close_time"],
             "stop": r["stop_loss"], "pnl": journal_pnl(r) or 0.0} for r in rows]


def _session(t: datetime) -> str:
    h = t.astimezone(timezone.utc).hour
    return "Asian" if h < 7 else "London" if h < 13 else "New York" if h < 21 else "Asian"


def insights(trades: list[dict]) -> dict:
    """Plain-language notes on habits. Each is worked out from the trades given, oldest first."""
    n = len(trades)
    if n < MIN_TRADES:
        return {"trades": n, "needed": MIN_TRADES, "items": []}
    items: list[dict] = []
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] < 0]
    win_rate = len(wins) / n * 100

    # 1. Trading again soon after a loss.
    closed = sorted(trades, key=lambda t: t["close"])
    after_loss = []
    for t in trades:
        prev = [p for p in closed if p["close"] <= t["open"] and p is not t]
        if prev and prev[-1]["pnl"] < 0 and (t["open"] - prev[-1]["close"]) <= timedelta(minutes=QUICK_REENTRY_MIN):
            after_loss.append(t)
    if len(after_loss) >= 2:
        wr = sum(t["pnl"] > 0 for t in after_loss) / len(after_loss) * 100
        total = sum(t["pnl"] for t in after_loss)
        worse = wr < win_rate - 5 or total < 0
        items.append({
            "key": "revenge", "tone": "warn" if worse else "info",
            "title": "Quick trades after a loss",
            "metric": f"{len(after_loss)} trades",
            "body": (f"{len(after_loss)} trades were opened within {QUICK_REENTRY_MIN} minutes of a losing one. "
                     f"They won {wr:.0f}% of the time against {win_rate:.0f}% overall and made {total:+,.2f} in total. "
                     + ("A short pause after a loss, even ten minutes, often helps." if worse
                        else "So far they have held up, but it is worth keeping an eye on.")),
        })

    # 2. Size after a loss compared with after a win.
    up_after, down_after = [], []
    for prev, t in zip(closed, closed[1:]):
        (down_after if prev["pnl"] < 0 else up_after).append(t["units"] / prev["units"] if prev["units"] else 1)
    if len(down_after) >= 3 and median(down_after) >= 1.3:
        items.append({
            "key": "sizing", "tone": "warn", "title": "Bigger trades after losses",
            "metric": f"×{median(down_after):.1f}",
            "body": (f"After a loss your next trade was typically {median(down_after):.1f} times the size. "
                     "Raising size to win money back makes a bad run grow faster. Sizing from your stop keeps each loss the same."),
        })

    # 3. Overtrading days.
    per_day = Counter(t["open"].astimezone(timezone.utc).date() for t in trades)
    if len(per_day) >= 3:
        typical = median(per_day.values())
        busy = {d for d, k in per_day.items() if k >= max(2 * typical, 5)}
        if busy:
            busy_pnl = sum(t["pnl"] for t in trades if t["open"].astimezone(timezone.utc).date() in busy)
            items.append({
                "key": "overtrading", "tone": "warn" if busy_pnl < 0 else "info",
                "title": "Very busy days",
                "metric": f"{len(busy)} day{'s' if len(busy) != 1 else ''}",
                "body": (f"On {len(busy)} day{'s' if len(busy) != 1 else ''} you made at least twice your usual "
                         f"{typical:g} trades, and those days made {busy_pnl:+,.2f}. "
                         + ("Setting a daily trade limit can stop a busy day turning into a bad one." if busy_pnl < 0
                            else "They went fine this time; a daily limit still protects you on the days they don't.")),
            })

    # 4. Stops.
    with_stop = sum(t["stop"] is not None for t in trades)
    pct = with_stop / n * 100
    items.append({
        "key": "stops", "tone": "good" if pct >= 90 else "warn" if pct < 60 else "info",
        "title": "Stop losses", "metric": f"{pct:.0f}%",
        "body": (f"{with_stop} of {n} trades had a stop loss. "
                 + ("That is a strong habit." if pct >= 90
                    else "A stop on every trade means you decide the most you can lose before the market does.")),
    })

    # 5. Winners cut short, losers left to run.
    if len(wins) >= 2 and len(losses) >= 2:
        avg_w = sum(t["pnl"] for t in wins) / len(wins)
        avg_l = -sum(t["pnl"] for t in losses) / len(losses)
        hold = lambda ts: median((t["close"] - t["open"]).total_seconds() for t in ts)  # noqa: E731
        hw, hl = hold(wins), hold(losses)
        ratio = avg_w / avg_l if avg_l else None
        cut = ratio is not None and ratio < 1 and hl > hw * 1.5
        items.append({
            "key": "payoff", "tone": "warn" if cut else "good" if ratio and ratio >= 1.5 else "info",
            "title": "Average win and loss", "metric": f"{ratio:.2f} : 1" if ratio else "–",
            "body": (f"An average win made {avg_w:,.2f} and an average loss cost {avg_l:,.2f}. "
                     f"Winners were held for {_dur(hw)} and losers for {_dur(hl)}. "
                     + ("Holding losers longer than winners is the most common habit to work on: let the stop do its job."
                        if cut else "With wins bigger than losses, you can be wrong more often than right and still do well."
                        if ratio and ratio >= 1.5 else "")).strip(),
        })

    # 6. Which session suits you.
    by = {}
    for t in trades:
        by.setdefault(_session(t["open"]), []).append(t["pnl"])
    ranked = sorted(((s, sum(v), len(v)) for s, v in by.items() if len(v) >= 3), key=lambda x: x[1])
    if len(ranked) >= 2:
        worst, best = ranked[0], ranked[-1]
        items.append({
            "key": "session", "tone": "info", "title": "Time of day",
            "metric": best[0],
            "body": (f"Your trades in the {best[0]} session made {best[1]:+,.2f} over {best[2]} trades, "
                     f"and in the {worst[0]} session {worst[1]:+,.2f} over {worst[2]}. "
                     "Gold moves differently through the day, so some hours may suit your style better than others."),
        })

    # 7. Long or short bias.
    longs = sum(t["side"] == "long" for t in trades)
    if n >= 10 and (longs / n >= 0.85 or longs / n <= 0.15):
        side = "long" if longs / n >= 0.85 else "short"
        items.append({
            "key": "bias", "tone": "info", "title": "One direction",
            "metric": f"{max(longs, n - longs) / n * 100:.0f}% {side}",
            "body": (f"Almost all your trades were {side}. That is fine when it is a plan, but it can also mean "
                     "only seeing one side of the market."),
        })

    order = {"warn": 0, "info": 1, "good": 2}
    items.sort(key=lambda i: order[i["tone"]])
    return {"trades": n, "needed": MIN_TRADES, "win_rate_pct": round(win_rate, 1),
            "net": round(sum(t["pnl"] for t in trades), 2), "items": items}


def _dur(sec: float) -> str:
    if sec < 3600:
        return f"{max(sec / 60, 1):.0f} min"
    if sec < 86400 * 2:
        return f"{sec / 3600:.1f} h"
    return f"{sec / 86400:.1f} days"


@router.get("/insights")
def get_insights(source: Literal["paper", "journal"] = "paper", user: UserOut = Depends(current_user)):
    with db.conn() as c:
        trades = _paper_trades(c, user.id) if source == "paper" else _journal_trades(c, user.id)
    return {"source": source, **insights(trades)}


# ---------------------------------------------------------------------------
# Replay settlement, shared by free replay and the challenge
# ---------------------------------------------------------------------------

class ReplayTrade(BaseModel):
    side: Literal["long", "short"]
    units: float = Field(gt=0, le=1_000_000)
    entry_bar: int = Field(ge=0)
    exit_bar: int = Field(ge=0)
    stop: float | None = Field(None, gt=0)
    target: float | None = Field(None, gt=0)


def settle(bars: list[dict], t: ReplayTrade) -> dict:
    """Where one replay trade ends: at its stop or target if a later bar reaches it, else at the exit bar's close."""
    entry = bars[t.entry_bar]["c"]
    long = t.side == "long"
    exit_price, exit_bar, reason = bars[t.exit_bar]["c"], t.exit_bar, "closed"
    for i in range(t.entry_bar + 1, t.exit_bar + 1):
        b = bars[i]
        if t.stop is not None and (b["l"] <= t.stop if long else b["h"] >= t.stop):
            gap = b["o"] < t.stop if long else b["o"] > t.stop
            exit_price, exit_bar, reason = (b["o"] if gap else t.stop), i, "stop"
            break
        if t.target is not None and (b["h"] >= t.target if long else b["l"] <= t.target):
            gap = b["o"] > t.target if long else b["o"] < t.target
            exit_price, exit_bar, reason = (b["o"] if gap else t.target), i, "target"
            break
    p = (exit_price - entry) * t.units * (1 if long else -1)
    return {"entry_price": entry, "exit_price": exit_price, "exit_bar": exit_bar, "reason": reason, "pnl": p}


def score(bars: list[dict], trades: list[ReplayTrade], require_stop: bool) -> dict:
    """Settles every trade in order and checks the replay rules. Raises 422 when a rule is broken."""
    if not bars:
        raise HTTPException(422, "No candles to settle against")
    cash, peak, dd, last_exit, out = REPLAY_BALANCE, REPLAY_BALANCE, 0.0, 0, []
    for k, t in enumerate(trades, 1):
        if t.entry_bar >= len(bars) or t.exit_bar >= len(bars) or t.exit_bar < t.entry_bar:
            raise HTTPException(422, f"Trade {k} points at a candle outside the replay")
        if t.entry_bar < last_exit:
            raise HTTPException(422, f"Trade {k} opens before the previous trade closed")
        entry = bars[t.entry_bar]["c"]
        if t.units * entry > cash * REPLAY_LEVERAGE + 0.01:
            raise HTTPException(422, f"Trade {k} is bigger than 1:{REPLAY_LEVERAGE} leverage allows")
        if t.stop is not None and ((t.stop >= entry) if t.side == "long" else (t.stop <= entry)):
            raise HTTPException(422, f"Trade {k} has its stop on the wrong side of the entry")
        if require_stop:
            if t.stop is None:
                raise HTTPException(422, f"Trade {k} has no stop loss; every challenge trade needs one")
            risk = abs(entry - t.stop) * t.units
            if risk > cash * CHALLENGE_RISK_PCT / 100 + 0.01:
                raise HTTPException(422, f"Trade {k} risks more than {CHALLENGE_RISK_PCT:g}% of the balance")
        s = settle(bars, t)
        cash += s["pnl"]
        peak = max(peak, cash)
        dd = max(dd, (peak - cash) / peak * 100 if peak else 0)
        last_exit = s["exit_bar"]
        out.append({**t.model_dump(), **{k2: _r(v) if isinstance(v, float) else v for k2, v in s.items()}})
    wins = sum(1 for t in out if t["pnl"] > 0)
    return {"balance": _r(cash), "return_pct": _r((cash / REPLAY_BALANCE - 1) * 100), "max_drawdown_pct": _r(dd),
            "trades": len(out), "wins": wins, "detail": out}


def _bars(tf: str, start: int, end: int) -> tuple[list[dict], list[dict]]:
    session = prices.candles(tf=tf, start=start, end=end, limit=MAX_REPLAY_BARS)["bars"]
    context = prices.candles(tf=tf, start=None, end=start, limit=CONTEXT_BARS)["bars"]
    return context, session


# ---------------------------------------------------------------------------
# Free replay: any day with minute data, or any week with hourly data
# ---------------------------------------------------------------------------

@router.get("/replay")
def replay(day: date | None = None, tf: Literal["5m", "15m", "1h"] = "5m"):
    """A stretch to replay. 5m and 15m replay one day (06:00 to 21:00 UTC); 1h replays the five days from `day`."""
    rng = _range(tf)
    if not rng:
        raise HTTPException(404, "No candles at that timeframe yet")
    first, last = rng
    if day is None:
        span = max((last - first).days - 3, 1)
        day = _weekday(first.date() + timedelta(days=1 + random.randrange(span)))
    start, end = _window(day, tf)
    if end > last.timestamp() + 3600 or start < first.timestamp():
        raise HTTPException(422, f"Pick a day between {first.date()} and {(last - timedelta(days=1)).date()}")
    context, session = _bars(tf, start, end)
    if len(session) < 10:
        raise HTTPException(422, "The market was closed or quiet that day. Pick another one.")
    return {"tf": tf, "day": day.isoformat(), "start": start, "end": end, "context": context, "bars": session,
            "balance": REPLAY_BALANCE, "leverage": REPLAY_LEVERAGE,
            "range": {"first": first.date().isoformat(), "last": last.date().isoformat()}}


def _range(tf: str) -> tuple[datetime, datetime] | None:
    base = prices.TIMEFRAMES[tf][0]
    with db.conn() as c:
        r = c.execute("SELECT min(ts) AS a, max(ts) AS b FROM candles WHERE symbol = %s AND tf = %s",
                      (config.SYMBOL, base)).fetchone()
    return (r["a"], r["b"]) if r and r["a"] else None


def _weekday(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _window(day: date, tf: str) -> tuple[int, int]:
    d0 = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    if tf == "1h":
        return int(d0.timestamp()), int((d0 + timedelta(days=7)).timestamp())
    return int((d0 + timedelta(hours=6)).timestamp()), int((d0 + timedelta(hours=21)).timestamp())


class SettleIn(BaseModel):
    tf: Literal["5m", "15m", "1h"]
    start: int
    end: int
    trades: list[ReplayTrade] = Field(max_length=200)


@router.post("/replay/settle")
def replay_settle(body: SettleIn):
    """Settles a free replay the same way the challenge is scored, so the two always agree."""
    _, session = _bars(body.tf, body.start, body.end)
    return score(session, body.trades, require_stop=False)


# ---------------------------------------------------------------------------
# Weekly challenge and opt-in leaderboard
# ---------------------------------------------------------------------------

def week_of(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _week_bounds(week: str) -> tuple[date, date]:
    monday = date.fromisocalendar(int(week[:4]), int(week[6:]), 1)
    return monday, monday + timedelta(days=7)


def challenge_window(c, week: str) -> dict:
    """The stretch everyone replays this week. Chosen once and stored, so it never moves."""
    row = c.execute("SELECT week, tf, start_ts, end_ts FROM challenges WHERE week = %s", (week,)).fetchone()
    if row:
        return row
    monday, _ = _week_bounds(week)
    seed = int(hashlib.sha256(f"goldlab-{week}".encode()).hexdigest(), 16)
    pick = None
    # A weekday with minute data, 8 to 40 days back, inside the minute history that is kept.
    for k in range(12):
        day = _weekday(monday - timedelta(days=8 + (seed >> (k * 5)) % 33))
        start, end = _window(day, "5m")
        n = c.execute("SELECT count(*) AS n FROM candles WHERE symbol = %s AND tf = '1m' AND ts >= to_timestamp(%s) "
                      "AND ts < to_timestamp(%s)", (config.SYMBOL, start, end)).fetchone()["n"]
        if n >= 600:
            pick = ("5m", start, end)
            break
    if pick is None:  # no minute data: a week of hourly bars from the last few years
        for k in range(12):
            day = monday - timedelta(days=30 + (seed >> (k * 7)) % 900)
            day -= timedelta(days=day.weekday())
            start, end = _window(day, "1h")
            n = c.execute("SELECT count(*) AS n FROM candles WHERE symbol = %s AND tf = '1h' AND ts >= to_timestamp(%s) "
                          "AND ts < to_timestamp(%s)", (config.SYMBOL, start, end)).fetchone()["n"]
            if n >= 60:
                pick = ("1h", start, end)
                break
    if pick is None:
        raise HTTPException(503, "There aren't enough candles for a challenge yet")
    return c.execute(
        "INSERT INTO challenges (week, tf, start_ts, end_ts) VALUES (%s, %s, %s, %s) "
        "ON CONFLICT (week) DO UPDATE SET week = EXCLUDED.week RETURNING week, tf, start_ts, end_ts",
        (week, *pick),
    ).fetchone()


def _board(c, week: str, user_id: int | None) -> dict:
    rows = c.execute(
        "SELECT user_id, nickname, return_pct, max_drawdown_pct, trades, public FROM challenge_entries "
        "WHERE week = %s ORDER BY return_pct DESC, max_drawdown_pct ASC, created_at ASC",
        (week,),
    ).fetchall()
    top, mine = [], None
    for rank, r in enumerate(rows, 1):
        row = {"rank": rank, "nickname": r["nickname"], "return_pct": r["return_pct"],
               "max_drawdown_pct": r["max_drawdown_pct"], "trades": r["trades"], "me": r["user_id"] == user_id}
        if r["user_id"] == user_id:
            mine = {**row, "public": r["public"]}
        if r["public"] and len(top) < 20:
            top.append(row)
    return {"players": len(rows), "top": top, "mine": mine}


@router.get("/challenge")
def challenge(user: UserOut = Depends(current_user)):
    today = datetime.now(timezone.utc).date()
    week = week_of(today)
    _, ends = _week_bounds(week)
    with db.conn() as c:
        w = challenge_window(c, week)
        board = _board(c, week, user.id)
        nick = c.execute("SELECT nickname FROM challenge_entries WHERE user_id = %s AND nickname IS NOT NULL "
                         "ORDER BY created_at DESC LIMIT 1", (user.id,)).fetchone()
        last = c.execute("SELECT week FROM challenges WHERE week < %s ORDER BY week DESC LIMIT 1", (week,)).fetchone()
        last_board = _board(c, last["week"], user.id) if last else None
    context, session = ([], []) if board["mine"] else _bars(w["tf"], w["start_ts"], w["end_ts"])
    return {
        "week": week, "ends": ends.isoformat(), "tf": w["tf"], "start": w["start_ts"], "end": w["end_ts"],
        "rules": {"balance": REPLAY_BALANCE, "leverage": REPLAY_LEVERAGE, "risk_pct": CHALLENGE_RISK_PCT},
        "context": context, "bars": session, "board": board, "nickname": nick["nickname"] if nick else None,
        "last_week": {"week": last["week"], **last_board} if last else None,
    }


def clean_nickname(v: str | None) -> str | None:
    if v is None or not v.strip():
        return None
    v = v.strip()
    if not NICK.match(v):
        raise ValueError("A nickname is 3 to 20 letters, numbers, spaces, dots, dashes or underscores")
    return v


class EntryIn(BaseModel):
    trades: list[ReplayTrade] = Field(max_length=200)
    public: bool = False
    nickname: str | None = None

    @field_validator("nickname")
    @classmethod
    def _nick(cls, v: str | None):
        return clean_nickname(v)


@router.post("/challenge", status_code=201)
def enter(body: EntryIn, user: UserOut = Depends(current_user)):
    if body.public and not body.nickname:
        raise HTTPException(422, "Pick a nickname to appear on the leaderboard")
    week = week_of(datetime.now(timezone.utc).date())
    with db.conn() as c:
        w = challenge_window(c, week)
        if c.execute("SELECT 1 FROM challenge_entries WHERE user_id = %s AND week = %s", (user.id, week)).fetchone():
            raise HTTPException(409, "You have already played this week's challenge")
    _, session = _bars(w["tf"], w["start_ts"], w["end_ts"])
    result = score(session, body.trades, require_stop=True)
    with db.conn() as c:
        c.execute(
            "INSERT INTO challenge_entries (user_id, week, return_pct, max_drawdown_pct, trades, wins, public, nickname) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
            (user.id, week, result["return_pct"], result["max_drawdown_pct"], result["trades"], result["wins"],
             body.public, body.nickname),
        )
        board = _board(c, week, user.id)
    return {**result, "board": board}


class VisibilityIn(BaseModel):
    public: bool
    nickname: str | None = None

    @field_validator("nickname")
    @classmethod
    def _nick(cls, v: str | None):
        return clean_nickname(v)


@router.patch("/challenge")
def visibility(body: VisibilityIn, user: UserOut = Depends(current_user)):
    """Join or leave this week's public leaderboard after playing."""
    week = week_of(datetime.now(timezone.utc).date())
    with db.conn() as c:
        row = c.execute("SELECT nickname FROM challenge_entries WHERE user_id = %s AND week = %s",
                        (user.id, week)).fetchone()
        if not row:
            raise HTTPException(404, "Play this week's challenge first")
        nick = body.nickname or row["nickname"]
        if body.public and not nick:
            raise HTTPException(422, "Pick a nickname to appear on the leaderboard")
        c.execute("UPDATE challenge_entries SET public = %s, nickname = %s WHERE user_id = %s AND week = %s",
                  (body.public, nick, user.id, week))
        return _board(c, week, user.id)


@router.get("/challenge/board")
def board(week: str = Query(pattern=r"^\d{4}-W\d{2}$"), user: UserOut = Depends(current_user)):
    with db.conn() as c:
        return _board(c, week, user.id)
