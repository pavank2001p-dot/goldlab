"""Paper trading: a practice account in virtual dollars, filled against real market prices.

One account trades every market in app.instruments (all priced in US dollars). Each market has its
own spread, overnight financing, trading hours and leverage cap: a position's margin is its value
divided by the lower of the account's leverage and the market's cap, like a broker's per-class limits.

Prices in the database are bids. Longs buy at the ask (bid + spread) and sell at the bid; shorts
sell at the bid and buy back at the ask, the same as the backtester. Limit and stop orders, stop
losses and take profits are checked against every minute bar since the account was last looked at,
using each bar's high and low, so nothing is missed while the page is closed. When a stop and a
target are both touched within one bar, the stop is assumed to have come first.

Broker-style tools: a trailing stop moves the stop loss behind the best price by a fixed distance
(checked after the bar's stop, so it never fills on the same bar it moved in); break-even moves the
stop to the entry; a partial close books part of a position as its own closed trade; and two pending
orders can be paired as one-cancels-other, so when one fills the other is cancelled.

No real money or broker is involved. This is for practice and learning only."""

import time
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from . import config, db
from . import instruments as ins
from .auth import UserOut, current_user
from .fit import _profile, assess
from .live import feed, feed_of
from .report import build_report, trading_date

router = APIRouter(prefix="/paper", tags=["paper"])

GOLD = ins.GOLD
START_BALANCE = 10_000.0
SPREAD = GOLD.spread     # gold: USD per ounce, paid once per round trip
SWAP = {"long": GOLD.swap_long, "short": GOLD.swap_short}  # gold: USD per ounce per night held
DEFAULT_LEVERAGE = 20    # 1:20, so a position can be worth up to 20 times the account
MAX_LEVERAGE = 1000      # forex brokers offer from 1:1 up to 1:500 or more
LEVERAGES = [1, 2, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000]
MAX_BALANCE = 1_000_000_000_000  # virtual money, so effectively unlimited
MARGIN_CALL_PCT = 100    # below this margin level a broker warns you and blocks new trades
STOP_OUT_PCT = 50        # positions are closed when equity falls below half the margin in use
MAX_PRICE_AGE = 3 * 3600  # older than this and the market is treated as closed
LIVE_AGE = 120           # a live quote younger than this is used ahead of saved bars
MAX_BARS = 20_000        # minute bars applied per market per request; the rest are applied next time
MAX_PRICE = 1e9
POS_COLS = ("id, symbol, side, units, entry_price, opened_at, stop_loss, take_profit, order_kind, closed_at, "
            "exit_price, close_reason, swap, pnl, trail, trailed_at")
ORDER_COLS = ("id, symbol, side, kind, units, price, stop_loss, take_profit, status, note, created_at, done_at, "
              "trail, oco_id")


def r2(x: float | None) -> float | None:
    return None if x is None else round(x, 2)


def _inst(symbol: str | None) -> ins.Instrument:
    try:
        return ins.get(symbol)
    except KeyError:
        raise HTTPException(404, f"Unknown market {symbol}")


def _of(row: dict) -> ins.Instrument:
    """The market of a stored position or order (a market later switched off falls back to its rules if known)."""
    sym = row.get("symbol") or GOLD.symbol
    return ins.BY_SYMBOL.get(sym) or next((i for i in ins.ALL if i.symbol == sym), GOLD)


# ---------------------------------------------------------------------------
# Prices
# ---------------------------------------------------------------------------

def current_price(symbol: str = GOLD.symbol) -> dict | None:
    """Latest bid for a market: the live quote when it is fresh, otherwise the newest saved bar's close."""
    inst = _inst(symbol)
    live = feed if inst.symbol == GOLD.symbol else feed_of(inst.symbol)
    snap = live.snapshot() if live else {"price": None, "age_seconds": None}
    if snap["price"] and snap["age_seconds"] is not None and snap["age_seconds"] <= LIVE_AGE:
        t, bid, source = snap["t"], snap["price"], "live"
    else:
        with db.conn() as c:
            row = None
            for tf, step in (("1m", 60), ("1h", 3600)):
                row = c.execute("SELECT ts, close FROM candles WHERE symbol = %s AND tf = %s ORDER BY ts DESC LIMIT 1",
                                (inst.symbol, tf)).fetchone()
                if row:
                    break
        if not row:
            return None
        # A bar's close is the price at the end of the bar.
        t, bid, source = min(row["ts"].timestamp() + step, time.time()), row["close"], "bars"
    age = max(time.time() - t, 0)
    # Feeds simply stop when forex-hours markets close, so a fresh price is enough there. US stocks
    # keep their last bar for hours after the 16:00 close, so their session times are checked too.
    in_hours = inst.hours != "us_stock" or inst.is_open(datetime.now(timezone.utc))
    return {"symbol": inst.symbol, "bid": inst.round(bid), "ask": inst.round(bid + inst.spread), "t": t,
            "age_seconds": round(age), "open": age <= MAX_PRICE_AGE and in_hours, "in_hours": in_hours,
            "source": source}


def _bars(c, since: datetime, symbol: str) -> list[dict]:
    for tf in ("1m", "1h"):
        rows = c.execute(
            """SELECT ts, open, high, low, close FROM candles WHERE symbol = %s AND tf = %s AND ts >= %s
               ORDER BY ts LIMIT %s""",
            (symbol, tf, since, MAX_BARS)).fetchall()
        if rows:
            return rows
    return []


# ---------------------------------------------------------------------------
# Account state
# ---------------------------------------------------------------------------

def _account(c, user_id: int, lock: bool = False) -> dict:
    c.execute("INSERT INTO paper_accounts (user_id, starting_balance, balance, leverage) VALUES (%s, %s, %s, %s) "
              "ON CONFLICT DO NOTHING", (user_id, START_BALANCE, START_BALANCE, DEFAULT_LEVERAGE))
    return c.execute("SELECT * FROM paper_accounts WHERE user_id = %s" + (" FOR UPDATE" if lock else ""),
                     (user_id,)).fetchone()


def leverage_for(account_leverage: int, inst: ins.Instrument) -> int:
    """The leverage a market actually gets: the account's, capped by the market's limit."""
    return min(account_leverage, inst.max_leverage)


def _swap(p: dict, until: datetime) -> float:
    nights = (trading_date(int(until.timestamp())) - trading_date(int(p["opened_at"].timestamp()))).days
    return max(nights, 0) * p["units"] * _of(p).swap_per_unit(p["side"], p["entry_price"])


def _exit_price(side: str, bid: float, inst: ins.Instrument = GOLD) -> float:
    return bid if side == "long" else bid + inst.spread


def _gross(p: dict, exit_price: float) -> float:
    sign = 1 if p["side"] == "long" else -1
    return (exit_price - p["entry_price"]) * p["units"] * sign


def _mark(p: dict, bid: float, now: datetime, rate: float) -> dict:
    exit_ = _exit_price(p["side"], bid, _of(p))
    swap = _swap(p, now)
    return {"mark": exit_, "swap": swap, "pnl": _gross(p, exit_) + swap,
            "margin": p["units"] * bid * rate}


class _Book:
    """Open positions and pending orders for one account across markets, applied bar by bar."""

    def __init__(self, c, user_id: int, account: dict):
        self.c, self.user_id, self.balance = c, user_id, account["balance"]
        self.leverage = account["leverage"]
        self.positions = c.execute(f"SELECT {POS_COLS} FROM paper_positions WHERE user_id = %s AND closed_at IS NULL "
                                   "ORDER BY opened_at, id", (user_id,)).fetchall()
        self.orders = c.execute(f"SELECT {ORDER_COLS} FROM paper_orders WHERE user_id = %s AND status = 'pending' "
                                "ORDER BY created_at, id", (user_id,)).fetchall()
        # Latest bid per market, moved as bars are applied; a position with no price yet is marked at entry.
        self.bids: dict[str, float] = {}

    @property
    def rate(self) -> float:
        """Share of a gold position's value held as margin."""
        return self.rate_for(GOLD)

    def rate_for(self, inst: ins.Instrument) -> float:
        return 1 / leverage_for(self.leverage, inst)

    def symbols(self) -> set[str]:
        return {p["symbol"] for p in self.positions} | {o["symbol"] for o in self.orders}

    def equity(self, bid: float | None = None, at: datetime | None = None,
               symbol: str = GOLD.symbol) -> tuple[float, float]:
        """(equity, margin in use). A bid given here becomes that market's latest price first."""
        if bid is not None:
            self.bids[symbol] = bid
        at = at or datetime.now(timezone.utc)
        marks = [_mark(p, self.bids.get(p["symbol"], p["entry_price"]), at, self.rate_for(_of(p)))
                 for p in self.positions]
        return self.balance + sum(m["pnl"] for m in marks), sum(m["margin"] for m in marks)

    def open(self, side: str, units: float, price: float, at: datetime, sl, tp, kind: str,
             symbol: str = GOLD.symbol, trail: float | None = None) -> dict:
        inst = _inst(symbol)
        if trail:
            # A trailing stop starts its distance from the fill, unless a tighter stop was given.
            start = _exit_price(side, price - (inst.spread if side == "long" else 0), inst)
            start = start - trail if side == "long" else start + trail
            sl = start if sl is None else (max(sl, start) if side == "long" else min(sl, start))
            sl = inst.round(sl)
        p = self.c.execute(
            f"""INSERT INTO paper_positions (user_id, symbol, side, units, entry_price, opened_at, stop_loss, take_profit,
                                             order_kind, trail)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING {POS_COLS}""",
            (self.user_id, inst.symbol, side, units, inst.round(price), at, sl, tp, kind, trail or None)).fetchone()
        self.positions.append(p)
        return p

    def close(self, p: dict, exit_price: float, at: datetime, reason: str) -> dict:
        swap = _swap(p, at)
        pnl = round(_gross(p, exit_price) + swap, 2)
        self.balance += pnl
        row = self.c.execute(
            f"""UPDATE paper_positions SET closed_at = %s, exit_price = %s, close_reason = %s, swap = %s, pnl = %s
                WHERE id = %s RETURNING {POS_COLS}""",
            (at, _of(p).round(exit_price), reason, round(swap, 2), pnl, p["id"])).fetchone()
        self.positions = [q for q in self.positions if q["id"] != p["id"]]
        return row

    def close_part(self, p: dict, units: float, exit_price: float, at: datetime, reason: str) -> dict:
        """Close some of a position: the closed part becomes its own closed trade with the same entry,
        and the rest stays open under the original id with its stop and target."""
        part = self.c.execute(
            f"""INSERT INTO paper_positions (user_id, symbol, side, units, entry_price, opened_at, stop_loss, take_profit,
                                             order_kind, agent, trail)
                SELECT user_id, symbol, side, %s, entry_price, opened_at, stop_loss, take_profit, order_kind, agent, trail
                FROM paper_positions WHERE id = %s RETURNING {POS_COLS}""", (units, p["id"])).fetchone()
        rest = self.c.execute(f"UPDATE paper_positions SET units = units - %s WHERE id = %s RETURNING {POS_COLS}",
                              (units, p["id"])).fetchone()
        self.positions = [rest if q["id"] == p["id"] else q for q in self.positions] + [part]
        return self.close(part, exit_price, at, reason)

    def set_stop(self, p: dict, sl: float, at: datetime) -> None:
        self.c.execute("UPDATE paper_positions SET stop_loss = %s, trailed_at = %s WHERE id = %s", (sl, at, p["id"]))
        p["stop_loss"], p["trailed_at"] = sl, at

    def finish_order(self, o: dict, status: str, at: datetime, note: str = "") -> None:
        self.c.execute("UPDATE paper_orders SET status = %s, done_at = %s, note = %s WHERE id = %s",
                       (status, at, note, o["id"]))
        self.orders = [q for q in self.orders if q["id"] != o["id"]]

    def apply(self, b: dict, symbol: str = GOLD.symbol) -> None:
        """Apply one bar (bid prices) of one market. Orders placed before the bar opened can fill in it;
        positions opened before it can hit their stop or target."""
        inst = _inst(symbol)
        sp = inst.spread
        at, o_, hi, lo, cl = b["ts"], b["open"], b["high"], b["low"], b["close"]
        self.bids[inst.symbol] = cl
        for o in list(self.orders):
            if o["symbol"] != inst.symbol or o["created_at"] > at:
                continue
            px, buy = o["price"], o["side"] == "long"
            if buy and o["kind"] == "limit" and lo + sp <= px:
                fill = min(px, o_ + sp)
            elif buy and o["kind"] == "stop" and hi + sp >= px:
                fill = max(px, o_ + sp)
            elif not buy and o["kind"] == "limit" and hi >= px:
                fill = max(px, o_)
            elif not buy and o["kind"] == "stop" and lo <= px:
                fill = min(px, o_)
            else:
                continue
            eq, used = self.equity(at=at)
            if used + o["units"] * fill * self.rate_for(inst) > eq:
                self.finish_order(o, "cancelled", at, "Not enough free margin when the price was reached")
                continue
            self.finish_order(o, "filled", at)
            self.open(o["side"], o["units"], fill, at, o["stop_loss"], o["take_profit"], o["kind"], inst.symbol,
                      o.get("trail"))
            # One-cancels-other: the paired order goes as soon as this one fills.
            mate = next((q for q in self.orders if o.get("oco_id") and q["id"] == o["oco_id"]), None)
            if mate:
                self.finish_order(mate, "cancelled", at, "Its one-cancels-other partner filled")

        for p in list(self.positions):
            if p["symbol"] != inst.symbol or p["opened_at"] >= at:
                continue
            sl, tp = p["stop_loss"], p["take_profit"]
            # A bar that already moved a trailing stop is never re-checked against the stop it produced.
            if p.get("trailed_at") and at <= p["trailed_at"]:
                sl = None
            if p["side"] == "long":
                if sl and lo <= sl:
                    self.close(p, min(sl, o_), at, "stop_loss")
                elif tp and hi >= tp:
                    self.close(p, max(tp, o_), at, "take_profit")
            else:
                if sl and hi + sp >= sl:
                    self.close(p, max(sl, o_ + sp), at, "stop_loss")
                elif tp and lo + sp <= tp:
                    self.close(p, min(tp, o_ + sp), at, "take_profit")

        # Trailing stops ratchet behind the best price of the bar, after this bar's stops were checked.
        for p in self.positions:
            if p["symbol"] != inst.symbol or not p.get("trail") or p["opened_at"] >= at:
                continue
            if p["side"] == "long":
                want = inst.round(hi - p["trail"])
                if p["stop_loss"] is None or want > p["stop_loss"]:
                    self.set_stop(p, want, at)
            else:
                want = inst.round(lo + sp + p["trail"])
                if p["stop_loss"] is None or want < p["stop_loss"]:
                    self.set_stop(p, want, at)

        if self.positions:
            eq, used = self.equity(at=at)
            if used and eq < used * STOP_OUT_PCT / 100:
                for p in list(self.positions):
                    self.close(p, _exit_price(p["side"], self.bids.get(p["symbol"], p["entry_price"]), _of(p)),
                               at, "stop_out")


def sync(c, user_id: int, symbol: str = GOLD.symbol) -> tuple[dict, _Book, dict | None]:
    """Bring the account up to date with prices since it was last looked at, across every market it
    has positions or orders in. Returns the account, the book and the latest price of `symbol`."""
    acct = _account(c, user_id, lock=True)
    book = _Book(c, user_id, acct)
    wanted = _inst(symbol).symbol
    markets = book.symbols() | {wanted}
    prices = {s: current_price(s) for s in markets if s in ins.BY_SYMBOL}
    if book.positions or book.orders:
        since = acct["checked_at"] - timedelta(minutes=1)
        per_market = {s: _bars(c, since, s) for s in book.symbols() if s in ins.BY_SYMBOL}
        # Markets are applied together in time order, so margin and stop-outs see every price as it was.
        merged = sorted(((b["ts"], s, b) for s, rows in per_market.items() for b in rows), key=lambda x: (x[0], x[1]))
        for _, s, b in merged:
            book.apply(b, s)
        for s, price in prices.items():
            if price and price["open"] and s in book.symbols():
                at = datetime.fromtimestamp(price["t"], timezone.utc)
                bid = price["bid"]
                book.apply({"ts": at, "open": bid, "high": bid, "low": bid, "close": bid}, s)
        # A market whose bars were cut off at MAX_BARS holds the clock back so the rest is applied next time.
        capped = [rows[-1]["ts"] for rows in per_market.values() if len(rows) >= MAX_BARS]
        ends = [rows[-1]["ts"] for rows in per_market.values() if rows]
        checked = min(capped) if capped else (max(ends) if ends else acct["checked_at"])
    else:
        checked = datetime.now(timezone.utc)
    for s, price in prices.items():
        if price:
            book.bids[s] = price["bid"]
    acct = c.execute("UPDATE paper_accounts SET balance = %s, checked_at = GREATEST(checked_at, %s) "
                     "WHERE user_id = %s RETURNING *", (round(book.balance, 2), checked, user_id)).fetchone()
    return acct, book, prices.get(wanted)


def _swap_now(inst: ins.Instrument, side: str, price: dict | None) -> float | None:
    """Financing per unit per night at today's price (fixed for gold)."""
    if not price and inst.swap_long is None:
        return None
    return round(inst.swap_per_unit(side, price["bid"] if price else 0.0), 6)


def summary(user_id: int, symbol: str = GOLD.symbol) -> dict:
    inst = _inst(symbol)
    with db.conn() as c:
        acct, book, price = sync(c, user_id, inst.symbol)
        history = c.execute(f"SELECT {POS_COLS} FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL "
                            "ORDER BY closed_at DESC, id DESC LIMIT 100", (user_id,)).fetchall()
        done = c.execute(f"SELECT {ORDER_COLS} FROM paper_orders WHERE user_id = %s AND status = 'cancelled' "
                         "ORDER BY done_at DESC LIMIT 20", (user_id,)).fetchall()
        counts = c.execute("SELECT count(*) AS n, count(*) FILTER (WHERE pnl > 0) AS wins, coalesce(sum(pnl), 0) AS net "
                           "FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL", (user_id,)).fetchone()
    now = datetime.now(timezone.utc)
    positions, unrealized, used = [], 0.0, 0.0
    for p in book.positions:
        bid = book.bids.get(p["symbol"])
        pi = _of(p)
        m = (_mark(p, bid, now, book.rate_for(pi)) if bid is not None
             else {"mark": None, "swap": 0.0, "pnl": None, "margin": 0.0})
        unrealized += m["pnl"] or 0
        used += m["margin"]
        positions.append({**p, "mark": None if m["mark"] is None else pi.round(m["mark"]), "swap": r2(m["swap"]),
                          "pnl": r2(m["pnl"]), "margin": r2(m["margin"]), "name": pi.name, "decimals": pi.decimals})
    equity = acct["balance"] + unrealized
    lev = leverage_for(acct["leverage"], inst)
    return {
        "account": {
            "starting_balance": acct["starting_balance"],
            "leverage": acct["leverage"],
            "balance": r2(acct["balance"]),
            "equity": r2(equity),
            "unrealized": r2(unrealized),
            "margin_used": r2(used),
            "free_margin": r2(equity - used),
            "margin_level_pct": r2(equity / used * 100) if used else None,
            "margin_call": bool(used) and equity < used * MARGIN_CALL_PCT / 100,
            "return_pct": r2((equity / acct["starting_balance"] - 1) * 100),
            "created_at": acct["created_at"],
            "closed_trades": counts["n"],
            "wins": counts["wins"],
            "realized": r2(counts["net"]),
        },
        "symbol": inst.symbol,
        "market": inst.public(),
        "price": price,
        "positions": positions,
        "orders": book.orders,
        "cancelled_orders": done,
        "history": history,
        "settings": {"spread": inst.spread,
                     "swap_long": _swap_now(inst, "long", price), "swap_short": _swap_now(inst, "short", price),
                     "margin_rate_pct": round(100 / lev, 4), "leverage": acct["leverage"],
                     "market_leverage": lev, "market_max_leverage": inst.max_leverage,
                     "leverages": LEVERAGES, "max_leverage": MAX_LEVERAGE, "max_balance": MAX_BALANCE,
                     "stop_out_pct": STOP_OUT_PCT, "margin_call_pct": MARGIN_CALL_PCT},
    }


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------

class OrderIn(BaseModel):
    symbol: str = Field(GOLD.symbol, description="Market to trade (see /prices/markets)")
    side: Literal["long", "short"]
    kind: Literal["market", "limit", "stop"] = "market"
    units: float = Field(gt=0, le=1e12, description="Units of the market: ounces, shares, barrels, currency units...")
    price: float | None = Field(None, gt=0, lt=MAX_PRICE, description="Trigger price for limit and stop orders")
    stop_loss: float | None = Field(None, gt=0, lt=MAX_PRICE)
    take_profit: float | None = Field(None, gt=0, lt=MAX_PRICE)
    trail: float | None = Field(None, gt=0, lt=MAX_PRICE, description="Trailing stop distance in price")
    oco_with: int | None = Field(None, description="A pending order to pair with: when either fills, the other is cancelled")

    @model_validator(mode="after")
    def _check(self):
        if self.oco_with is not None and self.kind == "market":
            raise ValueError("Only limit and stop orders can be paired as one-cancels-other")
        if self.kind == "market":
            self.price = None
        elif self.price is None:
            raise ValueError(f"A {self.kind} order needs a price")
        return self


class ProtectIn(BaseModel):
    stop_loss: float | None = Field(None, gt=0, lt=MAX_PRICE)
    take_profit: float | None = Field(None, gt=0, lt=MAX_PRICE)
    trail: float | None = Field(None, gt=0, lt=MAX_PRICE, description="Trailing distance; left out keeps it, null removes it")


class CloseIn(BaseModel):
    units: float | None = Field(None, gt=0, le=1e12, description="Units to close; left out closes the whole position")


class OrderEditIn(BaseModel):
    price: float | None = Field(None, gt=0, lt=MAX_PRICE)
    stop_loss: float | None = Field(None, gt=0, lt=MAX_PRICE)
    take_profit: float | None = Field(None, gt=0, lt=MAX_PRICE)


class ResetIn(BaseModel):
    balance: float = Field(START_BALANCE, ge=1, le=MAX_BALANCE)
    leverage: int = Field(DEFAULT_LEVERAGE, ge=1, le=MAX_LEVERAGE)


class LeverageIn(BaseModel):
    leverage: int = Field(ge=1, le=MAX_LEVERAGE)


class FundsIn(BaseModel):
    amount: float = Field(description="Positive adds virtual money, negative takes it out")

    @model_validator(mode="after")
    def _check(self):
        if self.amount == 0 or abs(self.amount) > MAX_BALANCE:
            raise ValueError(f"Choose an amount between $1 and ${MAX_BALANCE:,.0f}")
        return self


def _check_protection(side: str, ref: float, sl: float | None, tp: float | None) -> None:
    ref = round(ref, 6)
    if side == "long":
        if sl is not None and sl >= ref:
            raise HTTPException(422, f"For a buy, the stop loss must be below {ref:,.{_dp(ref)}f}")
        if tp is not None and tp <= ref:
            raise HTTPException(422, f"For a buy, the take profit must be above {ref:,.{_dp(ref)}f}")
    else:
        if sl is not None and sl <= ref:
            raise HTTPException(422, f"For a sell, the stop loss must be above {ref:,.{_dp(ref)}f}")
        if tp is not None and tp >= ref:
            raise HTTPException(422, f"For a sell, the take profit must be below {ref:,.{_dp(ref)}f}")


def _dp(x: float) -> int:
    """Decimals to show a price with: two for most markets, more for small prices like EUR/USD."""
    return 2 if abs(x) >= 10 else 5


def _check_trigger(side: str, kind: str, at: float, price: dict) -> None:
    """A buy limit waits for a lower price, a buy stop for a higher one; sells are the reverse."""
    ref = price["ask"] if side == "long" else price["bid"]
    wants_above = (side == "long") == (kind == "stop")
    if (at > ref) != wants_above or at == ref:
        where = "above" if wants_above else "below"
        name = "buy" if side == "long" else "sell"
        raise HTTPException(422, f"A {name} {kind} order's price must be {where} the current "
                                 f"{'ask' if side == 'long' else 'bid'} of {ref:,.{_dp(ref)}f}")


def _need_price(price: dict | None, inst: ins.Instrument = GOLD) -> dict:
    name = inst.name if inst.asset_class in ("stocks", "indices", "crypto") else inst.name.lower()
    if not price:
        raise HTTPException(409, f"No {name} price is available yet")
    if not price["open"]:
        why = (f"{inst.name} trades {inst.hours_text()}" if not price.get("in_hours", True)
               else "there have been no new prices for a while")
        raise HTTPException(409, f"The {name} market looks closed right now ({why}). "
                                 "You can still place limit and stop orders.")
    return price


@router.get("")
def get(symbol: str = GOLD.symbol, user: UserOut = Depends(current_user)):
    return summary(user.id, symbol)


@router.post("/orders", status_code=201)
def place(o: OrderIn, user: UserOut = Depends(current_user)):
    inst = _inst(o.symbol)
    with db.conn() as c:
        acct, book, price = sync(c, user.id, inst.symbol)
        price = price if price else _need_price(price, inst)
        bid, ask = price["bid"], price["ask"]
        if o.kind == "market":
            _need_price(price, inst)
            fill = ask if o.side == "long" else bid
            _check_protection(o.side, fill, o.stop_loss, o.take_profit)
            now = datetime.now(timezone.utc)
            eq, used = book.equity(bid, now, inst.symbol)
            need = o.units * bid * book.rate_for(inst)
            if used + need > eq:
                cap = (f" {inst.name} is capped at 1:{inst.max_leverage}."
                       if inst.max_leverage < acct["leverage"] else "")
                raise HTTPException(422, f"Not enough free margin: this needs ${need:,.2f} and ${max(eq - used, 0):,.2f} "
                                         f"is free.{cap} Try a smaller size.")
            p = book.open(o.side, o.units, fill, now, o.stop_loss, o.take_profit, "market", inst.symbol, o.trail)
            c.execute("UPDATE paper_accounts SET balance = %s WHERE user_id = %s", (round(book.balance, 2), user.id))
            return {"position": p}

        _check_trigger(o.side, o.kind, o.price, price)
        _check_protection(o.side, o.price, o.stop_loss, o.take_profit)
        mate = None
        if o.oco_with is not None:
            mate = next((q for q in book.orders if q["id"] == o.oco_with), None)
            if not mate:
                raise HTTPException(404, "The order to pair with isn't pending any more")
            if mate["symbol"] != inst.symbol:
                raise HTTPException(422, "One-cancels-other orders must be in the same market")
            if mate["oco_id"]:
                raise HTTPException(422, "That order is already paired with another")
        row = c.execute(
            f"""INSERT INTO paper_orders (user_id, symbol, side, kind, units, price, stop_loss, take_profit, trail, oco_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING {ORDER_COLS}""",
            (user.id, inst.symbol, o.side, o.kind, o.units, o.price, o.stop_loss, o.take_profit, o.trail,
             mate["id"] if mate else None)).fetchone()
        if mate:
            c.execute("UPDATE paper_orders SET oco_id = %s WHERE id = %s", (row["id"], mate["id"]))
        return {"order": row}


@router.delete("/orders/{oid}", status_code=204)
def cancel(oid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        sync(c, user.id)
        row = c.execute("UPDATE paper_orders SET status = 'cancelled', done_at = now(), note = 'Cancelled by you' "
                        "WHERE id = %s AND user_id = %s AND status = 'pending' RETURNING id", (oid, user.id)).fetchone()
    if not row:
        raise HTTPException(404, "Order not found or already filled")


@router.patch("/orders/{oid}")
def modify(oid: int, body: OrderEditIn, user: UserOut = Depends(current_user)):
    """Move a pending order's price, stop loss or take profit (dragging its lines on the chart).
    Fields left out keep their value; a stop loss or take profit sent as null is removed."""
    with db.conn() as c:
        acct, book, _ = sync(c, user.id)
        o = next((q for q in book.orders if q["id"] == oid), None)
        if not o:
            raise HTTPException(404, "Order not found or already filled")
        price = current_price(o["symbol"])
        at = body.price if body.price is not None else o["price"]
        sl = body.stop_loss if "stop_loss" in body.model_fields_set else o["stop_loss"]
        tp = body.take_profit if "take_profit" in body.model_fields_set else o["take_profit"]
        if price and at != o["price"]:
            _check_trigger(o["side"], o["kind"], at, price)
        _check_protection(o["side"], at, sl, tp)
        # A moved order counts from now, so a bar from before the move can't fill it at the new price.
        moved = "created_at = now(), " if at != o["price"] else ""
        row = c.execute(f"UPDATE paper_orders SET {moved}price = %s, stop_loss = %s, take_profit = %s "
                        f"WHERE id = %s AND status = 'pending' RETURNING {ORDER_COLS}", (at, sl, tp, oid)).fetchone()
    return {"order": row}


def _open_position(book: _Book, pid: int) -> dict:
    p = next((q for q in book.positions if q["id"] == pid), None)
    if not p:
        raise HTTPException(404, "Position not found or already closed")
    return p


@router.post("/positions/{pid}/close")
def close(pid: int, body: CloseIn | None = None, user: UserOut = Depends(current_user)):
    """Close a position, or only `units` of it (a partial close)."""
    with db.conn() as c:
        acct, book, _ = sync(c, user.id)
        p = _open_position(book, pid)
        inst = _of(p)
        price = _need_price(current_price(inst.symbol), inst)
        exit_, now = _exit_price(p["side"], price["bid"], inst), datetime.now(timezone.utc)
        units = body.units if body and body.units is not None else None
        if units is not None and units > p["units"] + 1e-9:
            raise HTTPException(422, f"The position only has {p['units']:g} to close")
        if units is None or units >= p["units"] - 1e-9:
            row = book.close(p, exit_, now, "manual")
        else:
            row = book.close_part(p, units, exit_, now, "partial")
        c.execute("UPDATE paper_accounts SET balance = %s WHERE user_id = %s", (round(book.balance, 2), user.id))
    return {"position": row}


@router.post("/positions/{pid}/breakeven")
def breakeven(pid: int, user: UserOut = Depends(current_user)):
    """Move the stop loss to the entry price, so the trade can no longer lose (apart from gaps and swap).
    Only allowed once the price has moved past the entry."""
    with db.conn() as c:
        acct, book, _ = sync(c, user.id)
        p = _open_position(book, pid)
        inst = _of(p)
        price = current_price(p["symbol"])
        if not price:
            raise HTTPException(409, "No price is available yet")
        _check_protection(p["side"], _exit_price(p["side"], price["bid"], inst), p["entry_price"], None)
        row = c.execute(f"UPDATE paper_positions SET stop_loss = %s WHERE id = %s RETURNING {POS_COLS}",
                        (p["entry_price"], pid)).fetchone()
    return {"position": row}


@router.patch("/positions/{pid}")
def protect(pid: int, body: ProtectIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        acct, book, _ = sync(c, user.id)
        p = _open_position(book, pid)
        price = current_price(p["symbol"])
        inst = _of(p)
        trail = body.trail if "trail" in body.model_fields_set else p["trail"]
        sl = body.stop_loss
        if trail and price and "trail" in body.model_fields_set:
            # Turning on (or changing) a trail places the stop that distance from the current price at once.
            mark = _exit_price(p["side"], price["bid"], inst)
            start = inst.round(mark - trail if p["side"] == "long" else mark + trail)
            sl = start if sl is None else (max(sl, start) if p["side"] == "long" else min(sl, start))
        if price:
            _check_protection(p["side"], _exit_price(p["side"], price["bid"], inst), sl, body.take_profit)
        row = c.execute(f"UPDATE paper_positions SET stop_loss = %s, take_profit = %s, trail = %s WHERE id = %s "
                        f"RETURNING {POS_COLS}", (sl, body.take_profit, trail, pid)).fetchone()
    return {"position": row}


@router.post("/reset")
def reset(body: ResetIn, symbol: str = GOLD.symbol, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        _account(c, user.id, lock=True)
        c.execute("DELETE FROM paper_orders WHERE user_id = %s", (user.id,))
        c.execute("DELETE FROM paper_positions WHERE user_id = %s", (user.id,))
        c.execute("UPDATE paper_accounts SET starting_balance = %s, balance = %s, leverage = %s, checked_at = now(), "
                  "created_at = now() WHERE user_id = %s", (body.balance, body.balance, body.leverage, user.id))
    return summary(user.id, symbol)


@router.patch("/settings")
def settings(body: LeverageIn, symbol: str = GOLD.symbol, user: UserOut = Depends(current_user)):
    """Change leverage. Like a broker, it applies to open positions too, so it is refused if the
    margin they would need takes the account to its stop-out level."""
    with db.conn() as c:
        acct, book, price = sync(c, user.id)
        if book.positions:
            book.leverage = body.leverage
            eq, used = book.equity(at=datetime.now(timezone.utc))
            if used and eq < used * STOP_OUT_PCT / 100:
                raise HTTPException(422, f"At 1:{body.leverage} your open positions would need ${used:,.2f} of margin, "
                                         f"which would close them at once. Close some first or pick higher leverage.")
        c.execute("UPDATE paper_accounts SET leverage = %s WHERE user_id = %s", (body.leverage, user.id))
    return summary(user.id, symbol)


@router.post("/funds")
def funds(body: FundsIn, symbol: str = GOLD.symbol, user: UserOut = Depends(current_user)):
    """Add or take out virtual money without resetting. Deposits count toward the starting balance,
    so the return shown is on everything put in."""
    with db.conn() as c:
        acct, book, price = sync(c, user.id)
        if body.amount < 0:
            eq, used = book.equity(at=datetime.now(timezone.utc))
            free = min(eq - used, book.balance)
            if -body.amount > free:
                raise HTTPException(422, f"You can take out at most ${max(free, 0):,.2f} while positions are open")
        if acct["starting_balance"] + body.amount > MAX_BALANCE:
            raise HTTPException(422, f"The account can hold at most ${MAX_BALANCE:,.0f}")
        c.execute("UPDATE paper_accounts SET balance = balance + %s, starting_balance = GREATEST(starting_balance + %s, 1) "
                  "WHERE user_id = %s", (body.amount, body.amount, user.id))
    return summary(user.id, symbol)


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
            "costs": round(_of(r).spread * r["units"], 2), "swap": r["swap"], "pnl": r["pnl"], "symbol": r["symbol"],
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

