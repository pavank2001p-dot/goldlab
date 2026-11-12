"""Prop challenge: practise the evaluation that funded-trader programmes use, on the paper account.

A challenge sets the paper account to a fixed size and leverage and adds the usual evaluation rules:

- Profit target: closed balance reaches the target (for example +10% in phase 1, +5% in phase 2) with no
  positions open.
- Daily loss limit: equity may not fall below the day's starting balance minus a share of the account size.
  The day runs from 17:00 New York to 17:00 New York, the same trading day the rest of the app uses.
- Maximum loss limit: equity may not fall below the account size minus a share of it, ever.
- Minimum trading days: days with at least one position opened, needed before a phase can pass.

Equity is checked against every minute bar's worst price for each open position (the low for a buy,
the high plus spread for a sell), so a limit is broken even if price recovers within the minute, the
way these programmes measure it. Breaking a limit closes everything at that price and fails the challenge.
Passing the last phase marks the challenge passed. Each phase starts on a fresh account, as programmes do.

Everything is virtual money for practice. Nothing here is affiliated with any prop firm."""

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, model_validator

from . import db, paper, record
from . import instruments as ins
from .auth import UserOut, current_user
from .learn import BY_ID as LESSONS
from .report import trading_date

router = APIRouter(prefix="/prop", tags=["prop"])

SIZES = [10_000, 25_000, 50_000, 100_000, 200_000]
PLANS = {
    "starter": {
        "label": "Starter", "blurb": "A gentler first try: one phase, looser limits, $10,000.",
        "sizes": [10_000], "targets": [8.0], "daily_loss_pct": 6.0, "max_loss_pct": 12.0, "min_days": 2, "leverage": 30,
    },
    "two_step": {
        "label": "Two-step evaluation", "blurb": "The common format: +10% then +5%, 5% daily and 10% overall loss limits.",
        "sizes": SIZES, "targets": [10.0, 5.0], "daily_loss_pct": 5.0, "max_loss_pct": 10.0, "min_days": 4, "leverage": 100,
    },
    "one_step": {
        "label": "One-step evaluation", "blurb": "One phase to +10% with tighter limits: 3% a day, 6% overall.",
        "sizes": SIZES, "targets": [10.0], "daily_loss_pct": 3.0, "max_loss_pct": 6.0, "min_days": 3, "leverage": 100,
    },
}
# What to read when a rule goes wrong (lessons in app.learn), and the tool that helps most.
RULE_HELP = {
    "daily_loss": {"lesson": "2008-lehman", "tip": "Size each trade so a full stop loss costs well under the day's limit, "
                                                    "and stop for the day after two losses."},
    "max_loss": {"lesson": "2013-crash", "tip": "Never add to a losing trade. Let the stop decide, and keep each trade's "
                                                 "risk to a small slice of the overall limit."},
    "no_stop": {"lesson": "2011-peak", "tip": "Decide the exit before you enter: a trade without a stop can break a "
                                               "limit in one move."},
    "stops_exceed": {"lesson": "2008-lehman", "tip": "Make positions smaller or move a stop closer, so a "
                                                      "losing day stays inside the limit."},
}
CHALLENGE_COLS = ("id, user_id, plan, size, leverage, rules, phase, status, phase_started_at, day, day_start_balance, "
                  "min_equity, worst_daily_pct, fail_rule, fail_detail, phase_results, final, started_at, ended_at")


def r2(x: float | None) -> float | None:
    return None if x is None else round(x, 2)


def _usd(x: float) -> str:
    return f"{'-' if x < 0 else ''}${abs(x):,.2f}"


def _tdate(at: datetime):
    return trading_date(int(at.timestamp()))


# ---------------------------------------------------------------------------
# Rule checking, called by the paper engine as it applies prices
# ---------------------------------------------------------------------------

class Rules:
    """Checks one active challenge bar by bar. Created by attach() for each paper sync."""

    def __init__(self, c, ch: dict):
        self.c, self.ch = c, ch

    @property
    def size(self) -> float:
        return self.ch["size"]

    def floors(self) -> tuple[float, float]:
        """(daily floor, overall floor): the equity each limit stops at."""
        rules = self.ch["rules"]
        return (self.ch["day_start_balance"] - self.size * rules["daily_loss_pct"] / 100,
                self.size * (1 - rules["max_loss_pct"] / 100))

    def roll(self, book, at: datetime) -> None:
        """A new trading day starts from the balance at that moment."""
        d = _tdate(at)
        if self.ch["day"] is None or d > self.ch["day"]:
            self.ch["day"], self.ch["day_start_balance"] = d, book.balance

    def before_bar(self, book, at: datetime) -> None:
        if self.ch["status"] == "active":
            self.roll(book, at)

    def _worst(self, book, b: dict, inst: ins.Instrument) -> tuple[float, dict]:
        """Equity at the bar's worst price for each position in this market, and the exit used for each."""
        at = b["ts"]
        eq, exits = book.balance, {}
        for p in book.positions:
            pi = paper._of(p)
            if p["symbol"] == inst.symbol and p["opened_at"] < at:
                x = b["low"] if p["side"] == "long" else b["high"] + book.cond.spread(inst, at)
            else:
                x = paper._exit_price(p["side"], book.bids.get(p["symbol"], p["entry_price"]), pi)
            exits[p["id"]] = x
            eq += paper._gross(p, x) + paper._swap(p, at)
        return eq, exits

    def after_bar(self, book, b: dict, inst: ins.Instrument) -> None:
        if self.ch["status"] != "active":
            return
        eq, exits = self._worst(book, b, inst)
        self.track(eq)
        daily, overall = self.floors()
        if eq <= overall + 1e-9:
            self.fail(book, b["ts"], exits, "max_loss",
                      f"Equity fell to {_usd(eq)}, below the overall floor of ${overall:,.2f}.")
        elif eq <= daily + 1e-9:
            self.fail(book, b["ts"], exits, "daily_loss",
                      f"Equity fell to {_usd(eq)}, below today's floor of ${daily:,.2f} "
                      f"(the day started at ${self.ch['day_start_balance']:,.2f}).")

    def track(self, eq: float) -> None:
        ch = self.ch
        ch["min_equity"] = eq if ch["min_equity"] is None else min(ch["min_equity"], eq)
        used = max(ch["day_start_balance"] - eq, 0) / self.size * 100
        ch["worst_daily_pct"] = max(ch["worst_daily_pct"] or 0, used)

    def fail(self, book, at: datetime, exits: dict, rule: str, detail: str) -> None:
        for p in list(book.positions):
            book.close(p, exits.get(p["id"], p["entry_price"]), at, "challenge_" + rule)
        label = "daily loss limit" if rule == "daily_loss" else "maximum loss limit"
        for o in list(book.orders):
            book.finish_order(o, "cancelled", at, f"Cancelled: the challenge's {label} was broken")
        self.ch["min_equity"] = min(self.ch["min_equity"] or book.balance, book.balance)
        self.ch.update(status="failed", fail_rule=rule, fail_detail=detail, ended_at=at)
        self.ch["final"] = phase_stats(self.c, self.ch, book.balance)
        book.locked = ENDED["failed"]

    def finish(self, book, now: datetime) -> None:
        """After prices are applied: start a new day if one began, check for a pass, and save."""
        ch = self.ch
        if ch["status"] == "active":
            self.roll(book, now)
            eq, _ = book.equity(at=now)
            self.track(eq)
            target = self.size * (1 + ch["rules"]["targets"][ch["phase"] - 1] / 100)
            if (not book.positions and book.balance >= target - 0.005
                    and trading_days(self.c, ch) >= ch["rules"]["min_days"]):
                self.pass_phase(book, now)
        save(self.c, ch)

    def pass_phase(self, book, now: datetime) -> None:
        ch = self.ch
        ch["phase_results"] = [*(ch["phase_results"] or []), phase_stats(self.c, ch, book.balance)]
        for o in list(book.orders):
            book.finish_order(o, "cancelled", now, "Cancelled: the phase was passed")
        if ch["phase"] < len(ch["rules"]["targets"]):
            # The next phase starts on a fresh account of the same size.
            uid = ch["user_id"]
            record.note_reset(self.c, uid, self.size)
            self.c.execute("DELETE FROM paper_orders WHERE user_id = %s", (uid,))
            self.c.execute("DELETE FROM paper_positions WHERE user_id = %s", (uid,))
            self.c.execute("UPDATE paper_accounts SET starting_balance = %s, created_at = %s, checked_at = %s "
                           "WHERE user_id = %s", (self.size, now, now, uid))
            book.positions, book.orders, book.balance = [], [], self.size
            ch.update(phase=ch["phase"] + 1, phase_started_at=now, day=_tdate(now), day_start_balance=self.size,
                      min_equity=self.size, worst_daily_pct=0.0)
        else:
            ch.update(status="passed", ended_at=now, final=ch["phase_results"][-1])
            book.locked = ENDED["passed"]


ENDED = {
    "failed": "This prop challenge has ended because a loss limit was broken. Start a new challenge, or leave "
              "challenge mode to keep practising freely.",
    "passed": "You passed this prop challenge. Start a new one, or leave challenge mode to keep practising freely.",
}


def trading_days(c, ch: dict) -> int:
    rows = c.execute("SELECT opened_at FROM paper_positions WHERE user_id = %s AND opened_at >= %s",
                     (ch["user_id"], ch["phase_started_at"])).fetchall()
    return len({_tdate(r["opened_at"]) for r in rows})


def phase_stats(c, ch: dict, balance: float) -> dict:
    rows = c.execute("SELECT opened_at, closed_at, pnl FROM paper_positions WHERE user_id = %s AND opened_at >= %s "
                     "AND closed_at IS NOT NULL", (ch["user_id"], ch["phase_started_at"])).fetchall()
    by_day: dict = {}
    for r in rows:
        d = _tdate(r["closed_at"])
        by_day[d] = by_day.get(d, 0.0) + r["pnl"]
    return {
        "phase": ch["phase"], "balance": r2(balance), "profit": r2(balance - ch["size"]),
        "profit_pct": r2((balance / ch["size"] - 1) * 100), "trades": len(rows),
        "wins": sum(1 for r in rows if r["pnl"] > 0), "trading_days": trading_days(c, ch),
        "best_day": r2(max(by_day.values())) if by_day else None,
        "worst_day": r2(min(by_day.values())) if by_day else None,
        "worst_daily_pct": r2(ch["worst_daily_pct"] or 0),
        "max_drawdown_pct": r2(max(ch["size"] - (ch["min_equity"] or ch["size"]), 0) / ch["size"] * 100),
        "started_at": ch["phase_started_at"].isoformat() if ch["phase_started_at"] else None,
    }


def save(c, ch: dict) -> None:
    c.execute(
        """UPDATE prop_challenges SET phase = %s, status = %s, phase_started_at = %s, day = %s, day_start_balance = %s,
           min_equity = %s, worst_daily_pct = %s, fail_rule = %s, fail_detail = %s, phase_results = %s, final = %s,
           ended_at = %s WHERE id = %s""",
        (ch["phase"], ch["status"], ch["phase_started_at"], ch["day"], ch["day_start_balance"], ch["min_equity"],
         ch["worst_daily_pct"], ch["fail_rule"], ch["fail_detail"], Jsonb(ch["phase_results"] or []),
         Jsonb(ch["final"]) if ch["final"] is not None else None, ch["ended_at"], ch["id"]))


def _load(c, cid: int, lock: bool = False) -> dict | None:
    return c.execute(f"SELECT {CHALLENGE_COLS} FROM prop_challenges WHERE id = %s" + (" FOR UPDATE" if lock else ""),
                     (cid,)).fetchone()


def attach(c, acct: dict, book) -> None:
    """Called by paper.sync: hook the account's challenge, if any, into the book."""
    if not acct.get("challenge_id"):
        return
    ch = _load(c, acct["challenge_id"], lock=True)
    if not ch:
        return
    if ch["status"] == "active":
        book.rules = Rules(c, ch)
    elif ch["status"] in ENDED:
        book.locked = ENDED[ch["status"]]


def leave(c, acct: dict) -> None:
    """The account goes back to free practice; a challenge still running counts as given up."""
    if acct.get("challenge_id"):
        c.execute("UPDATE prop_challenges SET status = 'abandoned', ended_at = now() WHERE id = %s AND status = 'active'",
                  (acct["challenge_id"],))
        c.execute("UPDATE paper_accounts SET challenge_id = NULL WHERE user_id = %s", (acct["user_id"],))


# ---------------------------------------------------------------------------
# What the page shows
# ---------------------------------------------------------------------------

def _lesson(key: str) -> dict:
    h = RULE_HELP[key]
    les = LESSONS.get(h["lesson"])
    return {"tip": h["tip"], "lesson": {"id": les["id"], "title": les["title"], "takeaway": les["takeaway"]} if les else None}


def view(c, ch: dict, book=None) -> dict:
    """The challenge with its rules, progress on each, and warnings. Live numbers need the synced book."""
    rules, size = ch["rules"], ch["size"]
    phases = len(rules["targets"])
    target_pct = rules["targets"][min(ch["phase"], phases) - 1]
    out = {
        "id": ch["id"], "plan": ch["plan"], "label": rules.get("label") or PLANS.get(ch["plan"], {}).get("label", "Custom"),
        "size": size, "leverage": ch["leverage"], "status": ch["status"], "phase": ch["phase"], "phases": phases,
        "rules": rules, "started_at": ch["started_at"], "ended_at": ch["ended_at"],
        "phase_started_at": ch["phase_started_at"], "phase_results": ch["phase_results"] or [], "final": ch["final"],
        "fail_rule": ch["fail_rule"], "fail_detail": ch["fail_detail"],
        "fail_help": _lesson(ch["fail_rule"]) if ch["fail_rule"] in RULE_HELP else None,
    }
    if ch["status"] != "active" or book is None:
        return out

    now = datetime.now(timezone.utc)
    eq, _ = book.equity(at=now)
    daily_floor = ch["day_start_balance"] - size * rules["daily_loss_pct"] / 100
    max_floor = size * (1 - rules["max_loss_pct"] / 100)
    target = size * (1 + target_pct / 100)
    days = trading_days(c, ch)
    daily_used = max(ch["day_start_balance"] - eq, 0)
    daily_cap = size * rules["daily_loss_pct"] / 100
    max_used = max(size - eq, 0)
    max_cap = size * rules["max_loss_pct"] / 100

    # Equity if every open stop were hit now, to warn before a limit is at risk.
    no_stop = [p["id"] for p in book.positions if not p["stop_loss"]]
    at_stops = book.balance + sum(paper._gross(p, p["stop_loss"]) for p in book.positions if p["stop_loss"])
    warnings = []
    if no_stop:
        warnings.append({"key": "no_stop", "text": f"{len(no_stop)} open position{'s have' if len(no_stop) > 1 else ' has'} "
                                                   "no stop loss.", **_lesson("no_stop")})
    if book.positions and not no_stop and at_stops < max(daily_floor, max_floor):
        warnings.append({"key": "stops_exceed", "text": f"If every stop were hit, equity would fall to {_usd(at_stops)}, past "
                                                         f"{'the daily' if at_stops < daily_floor and daily_floor >= max_floor else 'the overall'} limit.", **_lesson("stops_exceed")})

    def pct(used, cap):
        return r2(min(used / cap * 100, 100)) if cap else 0.0

    out.update({
        "balance": r2(book.balance), "equity": r2(eq), "profit": r2(eq - size), "profit_pct": r2((eq / size - 1) * 100),
        "target_pct": target_pct, "target_balance": r2(target), "trading_days": days, "open_positions": len(book.positions),
        "day": ch["day"].isoformat() if ch["day"] else None, "day_start_balance": r2(ch["day_start_balance"]),
        "checks": [
            {"key": "target", "label": f"Profit target +{target_pct:g}%", "status": "done" if book.balance >= target else "open",
             "value": r2(eq - size), "limit": r2(target - size),
             "progress": r2(max(min((eq - size) / (target - size) * 100, 100), 0)),
             "text": (f"Target reached. Close open positions to finish the phase." if book.balance >= target and book.positions
                      else f"${max(target - eq, 0):,.2f} to go")},
            {"key": "daily_loss", "label": f"Daily loss under {rules['daily_loss_pct']:g}%",
             "status": "warn" if daily_used >= daily_cap * 0.7 else "ok", "value": r2(daily_used), "limit": r2(daily_cap),
             "progress": pct(daily_used, daily_cap), "floor": r2(daily_floor),
             "text": f"${max(eq - daily_floor, 0):,.2f} of room today. Equity must stay above ${daily_floor:,.2f}."},
            {"key": "max_loss", "label": f"Overall loss under {rules['max_loss_pct']:g}%",
             "status": "warn" if max_used >= max_cap * 0.7 else "ok", "value": r2(max_used), "limit": r2(max_cap),
             "progress": pct(max_used, max_cap), "floor": r2(max_floor),
             "text": f"${max(eq - max_floor, 0):,.2f} of room. Equity must stay above ${max_floor:,.2f}."},
            {"key": "min_days", "label": f"At least {rules['min_days']} trading day{'s' if rules['min_days'] != 1 else ''}",
             "status": "done" if days >= rules["min_days"] else "open", "value": days, "limit": rules["min_days"],
             "progress": r2(min(days / rules["min_days"] * 100, 100)) if rules["min_days"] else 100.0,
             "text": "A day counts when you open at least one position."},
        ],
        "warnings": warnings,
        "at_stops": r2(at_stops) if book.positions else None,
    })
    return out


def brief(c, acct: dict, book) -> dict | None:
    """The challenge for the paper page, or None in free practice."""
    if not acct.get("challenge_id"):
        return None
    ch = _load(c, acct["challenge_id"])
    return view(c, ch, book) if ch else None


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

class CustomRules(BaseModel):
    targets: list[float] = Field(min_length=1, max_length=2, description="Profit target per phase, in percent")
    daily_loss_pct: float = Field(ge=0.5, le=50)
    max_loss_pct: float = Field(ge=1, le=90)
    min_days: int = Field(ge=0, le=60)
    leverage: int = Field(ge=1, le=paper.MAX_LEVERAGE)

    @model_validator(mode="after")
    def _check(self):
        if any(not 0.5 <= t <= 100 for t in self.targets):
            raise ValueError("Each profit target must be between 0.5% and 100%")
        if self.daily_loss_pct > self.max_loss_pct:
            raise ValueError("The daily loss limit can't be larger than the overall limit")
        return self


class StartIn(BaseModel):
    plan: Literal["starter", "two_step", "one_step", "custom"]
    size: float = Field(10_000, ge=1_000, le=10_000_000)
    custom: CustomRules | None = None


def _plans() -> list[dict]:
    return [{"id": k, **v} for k, v in PLANS.items()]


def _history(c, user_id: int) -> list[dict]:
    rows = c.execute(f"SELECT {CHALLENGE_COLS} FROM prop_challenges WHERE user_id = %s ORDER BY started_at DESC, id DESC "
                     "LIMIT 20", (user_id,)).fetchall()
    return [view(c, r) for r in rows]


@router.get("")
def overview(user: UserOut = Depends(current_user)):
    with db.conn() as c:
        acct, book, _ = paper.sync(c, user.id)
        current = brief(c, acct, book)
        history = _history(c, user.id)
    return {"plans": _plans(), "current": current, "history": history, "max_leverage": paper.MAX_LEVERAGE}


@router.post("/start", status_code=201)
def start(body: StartIn, user: UserOut = Depends(current_user)):
    if body.plan == "custom":
        if not body.custom:
            raise HTTPException(422, "Set the custom rules")
        rules = {**body.custom.model_dump(), "label": "Custom"}
        size = body.size
    else:
        p = PLANS[body.plan]
        if body.size not in p["sizes"]:
            raise HTTPException(422, f"The {p['label']} comes in " + ", ".join(f"${s:,.0f}" for s in p["sizes"]))
        rules = {k: p[k] for k in ("targets", "daily_loss_pct", "max_loss_pct", "min_days", "leverage", "label")}
        size = body.size
    now = datetime.now(timezone.utc)
    with db.conn() as c:
        acct = paper._account(c, user.id, lock=True)
        leave(c, acct)
        record.note_reset(c, user.id, size)
        c.execute("DELETE FROM paper_orders WHERE user_id = %s", (user.id,))
        c.execute("DELETE FROM paper_positions WHERE user_id = %s", (user.id,))
        ch = c.execute(
            f"""INSERT INTO prop_challenges (user_id, plan, size, leverage, rules, phase_started_at, day, day_start_balance,
                                             min_equity, started_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING {CHALLENGE_COLS}""",
            (user.id, body.plan, size, rules["leverage"], Jsonb(rules), now, _tdate(now), size, size, now)).fetchone()
        c.execute("UPDATE paper_accounts SET starting_balance = %s, balance = %s, leverage = %s, checked_at = %s, "
                  "created_at = %s, challenge_id = %s WHERE user_id = %s",
                  (size, size, rules["leverage"], now, now, ch["id"], user.id))
    with db.conn() as c:
        acct, book, _ = paper.sync(c, user.id)
        return {"current": brief(c, acct, book)}


@router.post("/leave")
def leave_challenge(user: UserOut = Depends(current_user)):
    """Back to free practice. The account keeps its balance; a running challenge counts as given up."""
    with db.conn() as c:
        acct = paper._account(c, user.id, lock=True)
        if not acct.get("challenge_id"):
            raise HTTPException(409, "The account isn't running a challenge")
        leave(c, acct)
        return {"history": _history(c, user.id)}


@router.get("/{cid}")
def one(cid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        acct, book, _ = paper.sync(c, user.id)
        ch = _load(c, cid)
        if not ch or ch["user_id"] != user.id:
            raise HTTPException(404, "Challenge not found")
        return view(c, ch, book if acct.get("challenge_id") == cid else None)
