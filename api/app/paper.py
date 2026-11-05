"""Paper trading: a practice account in virtual dollars, filled against real XAU/USD prices.

Prices in the database are bids. Longs buy at the ask (bid + spread) and sell at the bid; shorts
sell at the bid and buy back at the ask, the same as the backtester. Limit and stop orders, stop
losses and take profits are checked against every minute bar since the account was last looked at,
using each bar's high and low, so nothing is missed while the page is closed. When a stop and a
target are both touched within one bar, the stop is assumed to have come first.

No real money or broker is involved. This is for practice and learning only."""

import time
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from . import config, db
from .auth import UserOut, current_user
from .fit import _profile, assess
from .live import feed
from .report import build_report, trading_date

router = APIRouter(prefix="/paper", tags=["paper"])

START_BALANCE = 10_000.0
SPREAD = 0.30            # USD per ounce, paid once per round trip
SWAP = {"long": -0.25, "short": 0.05}  # USD per ounce per night held
MARGIN_RATE = 0.05       # 5% margin, so positions can be up to 20 times the account
STOP_OUT_PCT = 50        # positions are closed when equity falls below half the margin in use
MAX_PRICE_AGE = 3 * 3600  # older than this and the market is treated as closed
LIVE_AGE = 120           # a live quote younger than this is used ahead of saved bars
MAX_BARS = 20_000        # minute bars applied per request; the rest are applied next time
POS_COLS = ("id, side, units, entry_price, opened_at, stop_loss, take_profit, order_kind, closed_at, exit_price, "
            "close_reason, swap, pnl")
ORDER_COLS = "id, side, kind, units, price, stop_loss, take_profit, status, note, created_at, done_at"


def r2(x: float | None) -> float | None:
    return None if x is None else round(x, 2)


# ---------------------------------------------------------------------------
# Prices
# ---------------------------------------------------------------------------

def current_price() -> dict | None:
    """Latest bid: the live quote when it is fresh, otherwise the newest saved bar's close."""
    snap = feed.snapshot()
    if snap["price"] and snap["age_seconds"] is not None and snap["age_seconds"] <= LIVE_AGE:
        t, bid, source = snap["t"], snap["price"], "live"
    else:
        with db.conn() as c:
            row = None
            for tf, step in (("1m", 60), ("1h", 3600)):
                row = c.execute("SELECT ts, close FROM candles WHERE symbol = %s AND tf = %s ORDER BY ts DESC LIMIT 1",
                                (config.SYMBOL, tf)).fetchone()
                if row:
                    break
        if not row:
            return None
        # A bar's close is the price at the end of the bar.
        t, bid, source = min(row["ts"].timestamp() + step, time.time()), row["close"], "bars"
    age = max(time.time() - t, 0)
    return {"bid": round(bid, 2), "ask": round(bid + SPREAD, 2), "t": t, "age_seconds": round(age),
            "open": age <= MAX_PRICE_AGE, "source": source}


def _bars(c, since: datetime) -> list[dict]:
    for tf in ("1m", "1h"):
        rows = c.execute(
            """SELECT ts, open, high, low, close FROM candles WHERE symbol = %s AND tf = %s AND ts >= %s
               ORDER BY ts LIMIT %s""",
            (config.SYMBOL, tf, since, MAX_BARS)).fetchall()
        if rows:
            return rows
    return []


# ---------------------------------------------------------------------------
# Account state
# ---------------------------------------------------------------------------

def _account(c, user_id: int, lock: bool = False) -> dict:
    c.execute("INSERT INTO paper_accounts (user_id, starting_balance, balance) VALUES (%s, %s, %s) "
              "ON CONFLICT DO NOTHING", (user_id, START_BALANCE, START_BALANCE))
    return c.execute("SELECT * FROM paper_accounts WHERE user_id = %s" + (" FOR UPDATE" if lock else ""),
                     (user_id,)).fetchone()


def _swap(p: dict, until: datetime) -> float:
    nights = (trading_date(int(until.timestamp())) - trading_date(int(p["opened_at"].timestamp()))).days
    return max(nights, 0) * p["units"] * SWAP[p["side"]]


def _exit_price(side: str, bid: float) -> float:
    return bid if side == "long" else bid + SPREAD


def _gross(p: dict, exit_price: float) -> float:
    sign = 1 if p["side"] == "long" else -1
    return (exit_price - p["entry_price"]) * p["units"] * sign


def _mark(p: dict, bid: float, now: datetime) -> dict:
    exit_ = _exit_price(p["side"], bid)
    swap = _swap(p, now)
    return {"mark": exit_, "swap": swap, "pnl": _gross(p, exit_) + swap,
            "margin": p["units"] * bid * MARGIN_RATE}


class _Book:
    """Open positions and pending orders for one account, applied bar by bar."""

    def __init__(self, c, user_id: int, account: dict):
        self.c, self.user_id, self.balance = c, user_id, account["balance"]
        self.positions = c.execute(f"SELECT {POS_COLS} FROM paper_positions WHERE user_id = %s AND closed_at IS NULL "
                                   "ORDER BY opened_at, id", (user_id,)).fetchall()
        self.orders = c.execute(f"SELECT {ORDER_COLS} FROM paper_orders WHERE user_id = %s AND status = 'pending' "
                                "ORDER BY created_at, id", (user_id,)).fetchall()

    def equity(self, bid: float, at: datetime) -> tuple[float, float]:
        marks = [_mark(p, bid, at) for p in self.positions]
        return self.balance + sum(m["pnl"] for m in marks), sum(m["margin"] for m in marks)

    def open(self, side: str, units: float, price: float, at: datetime, sl, tp, kind: str) -> dict:
        p = self.c.execute(
            f"""INSERT INTO paper_positions (user_id, side, units, entry_price, opened_at, stop_loss, take_profit, order_kind)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING {POS_COLS}""",
            (self.user_id, side, units, round(price, 2), at, sl, tp, kind)).fetchone()
        self.positions.append(p)
        return p

    def close(self, p: dict, exit_price: float, at: datetime, reason: str) -> dict:
        swap = _swap(p, at)
        pnl = round(_gross(p, exit_price) + swap, 2)
        self.balance += pnl
        row = self.c.execute(
            f"""UPDATE paper_positions SET closed_at = %s, exit_price = %s, close_reason = %s, swap = %s, pnl = %s
                WHERE id = %s RETURNING {POS_COLS}""",
            (at, round(exit_price, 2), reason, round(swap, 2), pnl, p["id"])).fetchone()
        self.positions = [q for q in self.positions if q["id"] != p["id"]]
        return row

    def finish_order(self, o: dict, status: str, at: datetime, note: str = "") -> None:
        self.c.execute("UPDATE paper_orders SET status = %s, done_at = %s, note = %s WHERE id = %s",
                       (status, at, note, o["id"]))
        self.orders = [q for q in self.orders if q["id"] != o["id"]]

    def apply(self, b: dict) -> None:
        """Apply one bar (bid prices). Orders placed before the bar opened can fill in it; positions
        opened before it can hit their stop or target."""
        at, o_, hi, lo, cl = b["ts"], b["open"], b["high"], b["low"], b["close"]
        for o in list(self.orders):
            if o["created_at"] > at:
                continue
            px, buy = o["price"], o["side"] == "long"
            if buy and o["kind"] == "limit" and lo + SPREAD <= px:
                fill = min(px, o_ + SPREAD)
            elif buy and o["kind"] == "stop" and hi + SPREAD >= px:
                fill = max(px, o_ + SPREAD)
            elif not buy and o["kind"] == "limit" and hi >= px:
                fill = max(px, o_)
            elif not buy and o["kind"] == "stop" and lo <= px:
                fill = min(px, o_)
            else:
                continue
            eq, used = self.equity(cl, at)
            if used + o["units"] * fill * MARGIN_RATE > eq:
                self.finish_order(o, "cancelled", at, "Not enough free margin when the price was reached")
                continue
            self.finish_order(o, "filled", at)
            self.open(o["side"], o["units"], fill, at, o["stop_loss"], o["take_profit"], o["kind"])

        for p in list(self.positions):
            if p["opened_at"] >= at:
                continue
            sl, tp = p["stop_loss"], p["take_profit"]
            if p["side"] == "long":
                if sl and lo <= sl:
                    self.close(p, min(sl, o_), at, "stop_loss")
                elif tp and hi >= tp:
                    self.close(p, max(tp, o_), at, "take_profit")
            else:
                if sl and hi + SPREAD >= sl:
                    self.close(p, max(sl, o_ + SPREAD), at, "stop_loss")
                elif tp and lo + SPREAD <= tp:
                    self.close(p, min(tp, o_ + SPREAD), at, "take_profit")

        if self.positions:
            eq, used = self.equity(cl, at)
            if used and eq < used * STOP_OUT_PCT / 100:
                for p in list(self.positions):
                    self.close(p, _exit_price(p["side"], cl), at, "stop_out")


def sync(c, user_id: int) -> tuple[dict, _Book, dict | None]:
    """Bring the account up to date with prices since it was last looked at."""
    acct = _account(c, user_id, lock=True)
    book = _Book(c, user_id, acct)
    price = current_price()
    if book.positions or book.orders:
        bars = _bars(c, acct["checked_at"] - timedelta(minutes=1))
        for b in bars:
            book.apply(b)
        if price and price["open"]:
            at = datetime.fromtimestamp(price["t"], timezone.utc)
            bid = price["bid"]
            book.apply({"ts": at, "open": bid, "high": bid, "low": bid, "close": bid})
        checked = bars[-1]["ts"] if bars else acct["checked_at"]
    else:
        checked = datetime.now(timezone.utc)
    acct = c.execute("UPDATE paper_accounts SET balance = %s, checked_at = GREATEST(checked_at, %s) "
                     "WHERE user_id = %s RETURNING *", (round(book.balance, 2), checked, user_id)).fetchone()
    return acct, book, price


def summary(user_id: int) -> dict:
    with db.conn() as c:
        acct, book, price = sync(c, user_id)
        history = c.execute(f"SELECT {POS_COLS} FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL "
                            "ORDER BY closed_at DESC, id DESC LIMIT 100", (user_id,)).fetchall()
        done = c.execute(f"SELECT {ORDER_COLS} FROM paper_orders WHERE user_id = %s AND status = 'cancelled' "
                         "ORDER BY done_at DESC LIMIT 20", (user_id,)).fetchall()
        counts = c.execute("SELECT count(*) AS n, count(*) FILTER (WHERE pnl > 0) AS wins, coalesce(sum(pnl), 0) AS net "
                           "FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL", (user_id,)).fetchone()
    now = datetime.now(timezone.utc)
    positions, unrealized, used = [], 0.0, 0.0
    for p in book.positions:
        m = _mark(p, price["bid"], now) if price else {"mark": None, "swap": 0.0, "pnl": None, "margin": 0.0}
        unrealized += m["pnl"] or 0
        used += m["margin"]
        positions.append({**p, "mark": r2(m["mark"]), "swap": r2(m["swap"]), "pnl": r2(m["pnl"]),
                          "margin": r2(m["margin"])})
    equity = acct["balance"] + unrealized
    return {
        "account": {
            "starting_balance": acct["starting_balance"],
            "balance": r2(acct["balance"]),
            "equity": r2(equity),
            "unrealized": r2(unrealized),
            "margin_used": r2(used),
            "free_margin": r2(equity - used),
            "margin_level_pct": r2(equity / used * 100) if used else None,
            "return_pct": r2((equity / acct["starting_balance"] - 1) * 100),
            "created_at": acct["created_at"],
            "closed_trades": counts["n"],
            "wins": counts["wins"],
            "realized": r2(counts["net"]),
        },
        "price": price,
        "positions": positions,
        "orders": book.orders,
        "cancelled_orders": done,
        "history": history,
        "settings": {"spread": SPREAD, "swap_long": SWAP["long"], "swap_short": SWAP["short"],
                     "margin_rate_pct": MARGIN_RATE * 100, "max_leverage": round(1 / MARGIN_RATE),
                     "stop_out_pct": STOP_OUT_PCT},
    }


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------

class OrderIn(BaseModel):
    side: Literal["long", "short"]
    kind: Literal["market", "limit", "stop"] = "market"
    units: float = Field(gt=0, le=100_000, description="Ounces (1 standard lot = 100 oz)")
    price: float | None = Field(None, gt=0, lt=100_000, description="Trigger price for limit and stop orders")
    stop_loss: float | None = Field(None, gt=0, lt=100_000)
    take_profit: float | None = Field(None, gt=0, lt=100_000)

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "market":
            self.price = None
        elif self.price is None:
            raise ValueError(f"A {self.kind} order needs a price")
        return self


class ProtectIn(BaseModel):
    stop_loss: float | None = Field(None, gt=0, lt=100_000)
    take_profit: float | None = Field(None, gt=0, lt=100_000)


class ResetIn(BaseModel):
    balance: float = Field(START_BALANCE, ge=100, le=10_000_000)


def _check_protection(side: str, ref: float, sl: float | None, tp: float | None) -> None:
    if side == "long":
        if sl is not None and sl >= ref:
            raise HTTPException(422, f"For a buy, the stop loss must be below {ref:,.2f}")
        if tp is not None and tp <= ref:
            raise HTTPException(422, f"For a buy, the take profit must be above {ref:,.2f}")
    else:
        if sl is not None and sl <= ref:
            raise HTTPException(422, f"For a sell, the stop loss must be above {ref:,.2f}")
        if tp is not None and tp >= ref:
            raise HTTPException(422, f"For a sell, the take profit must be below {ref:,.2f}")


def _need_price(price: dict | None) -> dict:
    if not price:
        raise HTTPException(409, "No gold price is available yet")
    if not price["open"]:
        raise HTTPException(409, "The gold market looks closed right now (no new prices). "
                                 "You can still place limit and stop orders.")
    return price


@router.get("")
def get(user: UserOut = Depends(current_user)):
    return summary(user.id)


@router.post("/orders", status_code=201)
def place(o: OrderIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        acct, book, price = sync(c, user.id)
        if not price:
            raise HTTPException(409, "No gold price is available yet")
        bid, ask = price["bid"], price["ask"]
        if o.kind == "market":
            _need_price(price)
            fill = ask if o.side == "long" else bid
            _check_protection(o.side, fill, o.stop_loss, o.take_profit)
            now = datetime.now(timezone.utc)
            eq, used = book.equity(bid, now)
            need = o.units * bid * MARGIN_RATE
            if used + need > eq:
                raise HTTPException(422, f"Not enough free margin: this needs ${need:,.2f} and ${max(eq - used, 0):,.2f} "
                                         "is free. Try a smaller size.")
            p = book.open(o.side, o.units, fill, now, o.stop_loss, o.take_profit, "market")
            c.execute("UPDATE paper_accounts SET balance = %s WHERE user_id = %s", (round(book.balance, 2), user.id))
            return {"position": p}

        ref = ask if o.side == "long" else bid
        above = o.price > ref
        # A buy limit waits for a lower price, a buy stop for a higher one; sells are the reverse.
        wants_above = (o.side == "long") == (o.kind == "stop")
        if above != wants_above or o.price == ref:
            where = "above" if wants_above else "below"
            side = "buy" if o.side == "long" else "sell"
            raise HTTPException(422, f"A {side} {o.kind} order's price must be {where} the current "
                                     f"{'ask' if o.side == 'long' else 'bid'} of {ref:,.2f}")
        _check_protection(o.side, o.price, o.stop_loss, o.take_profit)
        row = c.execute(
            f"""INSERT INTO paper_orders (user_id, side, kind, units, price, stop_loss, take_profit)
                VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING {ORDER_COLS}""",
            (user.id, o.side, o.kind, o.units, o.price, o.stop_loss, o.take_profit)).fetchone()
        return {"order": row}


@router.delete("/orders/{oid}", status_code=204)
def cancel(oid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        sync(c, user.id)
        row = c.execute("UPDATE paper_orders SET status = 'cancelled', done_at = now(), note = 'Cancelled by you' "
                        "WHERE id = %s AND user_id = %s AND status = 'pending' RETURNING id", (oid, user.id)).fetchone()
    if not row:
        raise HTTPException(404, "Order not found or already filled")


def _open_position(book: _Book, pid: int) -> dict:
    p = next((q for q in book.positions if q["id"] == pid), None)
    if not p:
        raise HTTPException(404, "Position not found or already closed")
    return p


@router.post("/positions/{pid}/close")
def close(pid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        acct, book, price = sync(c, user.id)
        p = _open_position(book, pid)
        price = _need_price(price)
        row = book.close(p, _exit_price(p["side"], price["bid"]), datetime.now(timezone.utc), "manual")
        c.execute("UPDATE paper_accounts SET balance = %s WHERE user_id = %s", (round(book.balance, 2), user.id))
    return {"position": row}


@router.patch("/positions/{pid}")
def protect(pid: int, body: ProtectIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        acct, book, price = sync(c, user.id)
        p = _open_position(book, pid)
        if price:
            _check_protection(p["side"], _exit_price(p["side"], price["bid"]), body.stop_loss, body.take_profit)
        row = c.execute(f"UPDATE paper_positions SET stop_loss = %s, take_profit = %s WHERE id = %s RETURNING {POS_COLS}",
                        (body.stop_loss, body.take_profit, pid)).fetchone()
    return {"position": row}


@router.post("/reset")
def reset(body: ResetIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        _account(c, user.id, lock=True)
        c.execute("DELETE FROM paper_orders WHERE user_id = %s", (user.id,))
        c.execute("DELETE FROM paper_positions WHERE user_id = %s", (user.id,))
        c.execute("UPDATE paper_accounts SET starting_balance = %s, balance = %s, checked_at = now(), created_at = now() "
                  "WHERE user_id = %s", (body.balance, body.balance, user.id))
    return summary(user.id)


# ---------------------------------------------------------------------------
# Report, in the same shape as backtests and the trade log
# ---------------------------------------------------------------------------

def paper_report(user_id: int) -> dict:
    with db.conn() as c:
        acct, _, _ = sync(c, user_id)
        rows = c.execute(f"SELECT {POS_COLS} FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL "
                         "ORDER BY closed_at, id", (user_id,)).fetchall()
    capital = acct["starting_balance"]
    trades, equity, cash = [], [(int(acct["created_at"].timestamp()), capital)], capital
    for r in rows:
        cash += r["pnl"]
        equity.append((int(r["closed_at"].timestamp()), cash))
        trades.append({
            "id": r["id"], "side": r["side"], "units": r["units"],
            "entry_time": int(r["opened_at"].timestamp()), "entry_price": r["entry_price"],
            "exit_time": int(r["closed_at"].timestamp()), "exit_price": r["exit_price"],
            "costs": round(SPREAD * r["units"], 2), "swap": r["swap"], "pnl": r["pnl"],
            "stop_loss": r["stop_loss"], "take_profit": r["take_profit"], "exit_reason": r["close_reason"],
        })
    rep = build_report(trades, equity, capital)
    rep["capital"] = capital
    return rep


@router.get("/report")
def report(user: UserOut = Depends(current_user)):
    return paper_report(user.id)


@router.get("/fit")
def fit(user: UserOut = Depends(current_user)):
    profile = _profile(user.id)
    rep = paper_report(user.id)
    return assess(rep["trades"], rep["stats"], rep["capital"], profile)

