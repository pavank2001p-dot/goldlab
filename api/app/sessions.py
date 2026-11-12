"""Manual backtesting sessions: replay any date range, with a synced higher-timeframe chart, an optional blind
mode, and the progress saved so a long session can be paused and resumed on any device.

A session is a range of candles at one base timeframe (5m, 15m or 1h) plus the higher timeframe shown beside it
(1h, 4h or 1 day). Blind mode is a viewing choice: the page hides dates, times and news until the session ends,
so results aren't coloured by remembering what happened. The candles and the scoring are the same as the
quick replay (`app.practice.score`), so a finished session is settled on the server exactly as shown."""

import json
import random
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, model_validator

from . import config, db, prices
from .auth import UserOut, current_user
from .practice import CONTEXT_BARS, REPLAY_BALANCE, REPLAY_LEVERAGE, ReplayTrade, score

router = APIRouter(prefix="/practice/sessions", tags=["practice"])

SessionTf = Literal["5m", "15m", "1h"]
HIGHER: dict[str, tuple[str, int]] = {"5m": ("1h", 3600), "15m": ("4h", 14400), "1h": ("1d", 86400)}
MAX_BARS = 3000
MAX_SESSIONS = 30
MAX_STATE_BYTES = 200_000
RANDOM_DAYS = {"5m": 5, "15m": 10, "1h": 60}  # length of a "surprise me" session


def _utc(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def _range(tf: str) -> tuple[datetime, datetime] | None:
    base = prices.TIMEFRAMES[tf][0]
    with db.conn() as c:
        r = c.execute("SELECT min(ts) AS a, max(ts) AS b FROM candles WHERE symbol = %s AND tf = %s",
                      (config.SYMBOL, base)).fetchone()
    return (r["a"], r["b"]) if r and r["a"] else None


def candles(tf: str, start: datetime, end: datetime) -> dict:
    """The session's candles, the candles before it, and the higher timeframe's candles before it."""
    s, e = int(start.timestamp()), int(end.timestamp())
    bars = prices.candles(tf=tf, start=s, end=e, limit=MAX_BARS)["bars"]
    context = prices.candles(tf=tf, start=None, end=s, limit=CONTEXT_BARS)["bars"]
    htf, secs = HIGHER[tf]
    # Higher-timeframe candles that closed before the session; the one in progress is built from the session's own.
    htf_start = s - s % secs
    htf_context = prices.candles(tf=htf, start=None, end=htf_start, limit=CONTEXT_BARS)["bars"]
    return {"bars": bars, "context": context, "htf": {"tf": htf, "seconds": secs, "context": htf_context}}


class SessionIn(BaseModel):
    tf: SessionTf = "1h"
    start: date | None = Field(None, description="First day; left out picks a random stretch")
    end: date | None = Field(None, description="Day after the last one")
    blind: bool = False
    name: str = Field("", max_length=60)

    @model_validator(mode="after")
    def _check(self):
        if (self.start is None) != (self.end is None):
            raise ValueError("Give both a start and an end, or neither for a random stretch")
        if self.start and self.end and self.end <= self.start:
            raise ValueError("The end must be after the start")
        return self


class StateIn(BaseModel):
    state: dict[str, Any]
    finished: bool = False


class FinishIn(BaseModel):
    trades: list[ReplayTrade] = Field(max_length=500)


SESSION_COLS = "id, name, tf, start_at, end_at, blind, state, finished, result, created_at, updated_at"


def _public(r: dict, with_dates: bool = False) -> dict:
    """A session as listed. Blind sessions keep their dates hidden until they're finished."""
    hide = r["blind"] and not r["finished"] and not with_dates
    st = r["state"] or {}
    return {"id": r["id"], "name": r["name"], "tf": r["tf"], "blind": r["blind"], "finished": r["finished"],
            "start": None if hide else r["start_at"].date().isoformat(),
            "end": None if hide else r["end_at"].date().isoformat(),
            "progress": {"shown": st.get("k", 0), "trades": len(st.get("done", []))},
            "result": r["result"], "created_at": r["created_at"], "updated_at": r["updated_at"]}


@router.post("", status_code=201)
def create(body: SessionIn, user: UserOut = Depends(current_user)):
    rng = _range(body.tf)
    if not rng:
        raise HTTPException(404, "No candles at that timeframe yet")
    first, last = rng
    if body.start is None:
        days = RANDOM_DAYS[body.tf]
        span = max((last - first).days - days - 1, 1)
        start = _utc(first.date() + timedelta(days=1 + random.randrange(span)))
        end = start + timedelta(days=days)
    else:
        start, end = _utc(body.start), _utc(body.end)
        if start < first - timedelta(days=1) or start > last:
            raise HTTPException(422, f"Pick dates between {first.date()} and {last.date()} for {body.tf} candles")
        end = min(end, last + timedelta(hours=1))
    data = candles(body.tf, start, end)
    if len(data["bars"]) < 20:
        raise HTTPException(422, "There are too few candles in that range. Pick a longer one or a different timeframe.")
    if len(data["bars"]) >= MAX_BARS:
        # Too long for one session: it ends at the last candle that fits.
        end = datetime.fromtimestamp(data["bars"][-1]["t"] + 1, timezone.utc)
    with db.conn() as c:
        n = c.execute("SELECT count(*) AS n FROM replay_sessions WHERE user_id = %s AND NOT finished",
                      (user.id,)).fetchone()["n"]
        if n >= MAX_SESSIONS:
            raise HTTPException(422, f"You have {n} sessions in progress. Finish or delete one first.")
        row = c.execute(
            f"INSERT INTO replay_sessions (user_id, name, tf, start_at, end_at, blind) VALUES (%s, %s, %s, %s, %s, %s) "
            f"RETURNING {SESSION_COLS}", (user.id, body.name.strip(), body.tf, start, end, body.blind)).fetchone()
    return get(row["id"], user)


@router.get("")
def list_(user: UserOut = Depends(current_user)):
    with db.conn() as c:
        rows = c.execute(f"SELECT {SESSION_COLS} FROM replay_sessions WHERE user_id = %s ORDER BY updated_at DESC LIMIT 100",
                         (user.id,)).fetchall()
    return [_public(r) for r in rows]


def _own(c, sid: int, user_id: int) -> dict:
    r = c.execute(f"SELECT {SESSION_COLS} FROM replay_sessions WHERE id = %s AND user_id = %s", (sid, user_id)).fetchone()
    if not r:
        raise HTTPException(404, "Session not found")
    return r


@router.get("/{sid}")
def get(sid: int, user: UserOut = Depends(current_user)):
    """The session with its candles and saved progress."""
    with db.conn() as c:
        r = _own(c, sid, user.id)
    data = candles(r["tf"], r["start_at"], r["end_at"])
    return {**_public(r), "state": r["state"] or {}, **data, "balance": REPLAY_BALANCE, "leverage": REPLAY_LEVERAGE}


@router.put("/{sid}")
def save(sid: int, body: StateIn, user: UserOut = Depends(current_user)):
    """Save progress (candles shown, trades, the open trade and ticket settings) so the session can be resumed."""
    if len(json.dumps(body.state)) > MAX_STATE_BYTES:
        raise HTTPException(413, "That session state is too large to save")
    with db.conn() as c:
        r = _own(c, sid, user.id)
        if r["finished"]:
            raise HTTPException(409, "This session is finished")
        c.execute("UPDATE replay_sessions SET state = %s, updated_at = now() WHERE id = %s", (Jsonb(body.state), sid))
    return {"ok": True}


@router.post("/{sid}/finish")
def finish(sid: int, body: FinishIn, user: UserOut = Depends(current_user)):
    """Settle the trades on the server, the same way the replay and the challenge are scored, and close the session."""
    with db.conn() as c:
        r = _own(c, sid, user.id)
    bars = candles(r["tf"], r["start_at"], r["end_at"])["bars"]
    result = score(bars, body.trades, require_stop=False)
    with db.conn() as c:
        row = c.execute(f"UPDATE replay_sessions SET finished = true, result = %s, updated_at = now() WHERE id = %s "
                        f"RETURNING {SESSION_COLS}", (Jsonb(result), sid)).fetchone()
    return {**_public(row, with_dates=True), "result": result}


@router.delete("/{sid}", status_code=204)
def delete(sid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        c.execute("DELETE FROM replay_sessions WHERE id = %s AND user_id = %s", (sid, user.id))
