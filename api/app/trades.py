"""The user's own trade log: manual entries, broker CSV import, and the same report as a backtest."""

import csv
import io
import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field, model_validator

from . import db
from .auth import UserOut, current_user
from .report import build_report

router = APIRouter(prefix="/trades", tags=["trades"])

MAX_UPLOAD = 2 * 1024 * 1024
COLUMNS = "id, side, units, open_time, open_price, close_time, close_price, stop_loss, take_profit, fees, swap, notes, source"


class TradeIn(BaseModel):
    side: Literal["long", "short"]
    units: float = Field(gt=0, le=1_000_000, description="Ounces (1 standard lot = 100 oz)")
    open_time: datetime
    open_price: float = Field(gt=0, lt=100_000)
    close_time: datetime | None = None
    close_price: float | None = Field(None, gt=0, lt=100_000)
    stop_loss: float | None = Field(None, gt=0, lt=100_000)
    take_profit: float | None = Field(None, gt=0, lt=100_000)
    fees: float = Field(0, ge=0, le=1_000_000)
    swap: float = Field(0, ge=-1_000_000, le=1_000_000)
    notes: str = Field("", max_length=1000)

    @model_validator(mode="after")
    def _check(self):
        for name in ("open_time", "close_time"):
            v = getattr(self, name)
            if v is not None and v.tzinfo is None:
                setattr(self, name, v.replace(tzinfo=timezone.utc))
        if (self.close_time is None) != (self.close_price is None):
            raise ValueError("A closed trade needs both a close time and a close price")
        if self.close_time and self.close_time < self.open_time:
            raise ValueError("The close time must be after the open time")
        return self


def pnl(t: dict) -> float | None:
    if t["close_price"] is None:
        return None
    sign = 1 if t["side"] == "long" else -1
    return round((t["close_price"] - t["open_price"]) * t["units"] * sign - t["fees"] + t["swap"], 2)


def _out(row: dict) -> dict:
    return {**row, "pnl": pnl(row)}


def _insert(c, user_id: int, t: TradeIn, source: str = "manual", external_id: str | None = None):
    return c.execute(
        f"""INSERT INTO trades (user_id, side, units, open_time, open_price, close_time, close_price,
                                stop_loss, take_profit, fees, swap, notes, source, external_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING RETURNING {COLUMNS}""",
        (user_id, t.side, t.units, t.open_time, t.open_price, t.close_time, t.close_price,
         t.stop_loss, t.take_profit, t.fees, t.swap, t.notes, source, external_id),
    ).fetchone()


@router.get("")
def list_(user: UserOut = Depends(current_user)):
    with db.conn() as c:
        rows = c.execute(f"SELECT {COLUMNS} FROM trades WHERE user_id = %s ORDER BY open_time DESC", (user.id,)).fetchall()
    return [_out(r) for r in rows]


@router.post("", status_code=201)
def create(t: TradeIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        return _out(_insert(c, user.id, t))


@router.put("/{tid}")
def update(tid: int, t: TradeIn, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        row = c.execute(
            f"""UPDATE trades SET side=%s, units=%s, open_time=%s, open_price=%s, close_time=%s, close_price=%s,
                   stop_loss=%s, take_profit=%s, fees=%s, swap=%s, notes=%s
                WHERE id = %s AND user_id = %s RETURNING {COLUMNS}""",
            (t.side, t.units, t.open_time, t.open_price, t.close_time, t.close_price, t.stop_loss,
             t.take_profit, t.fees, t.swap, t.notes, tid, user.id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Trade not found")
    return _out(row)


@router.delete("/{tid}", status_code=204)
def delete(tid: int, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        c.execute("DELETE FROM trades WHERE id = %s AND user_id = %s", (tid, user.id))


@router.get("/report")
def report(capital: float = Query(10_000, gt=0, le=100_000_000), user: UserOut = Depends(current_user)):
    with db.conn() as c:
        rows = c.execute(
            f"SELECT {COLUMNS} FROM trades WHERE user_id = %s AND close_time IS NOT NULL ORDER BY close_time",
            (user.id,),
        ).fetchall()
    trades, equity, cash = [], [], capital
    for r in rows:
        p = pnl(r)
        if not equity:
            equity.append((int(r["open_time"].timestamp()), capital))
        cash += p
        equity.append((int(r["close_time"].timestamp()), cash))
        trades.append({
            "id": r["id"], "side": r["side"], "units": r["units"],
            "entry_time": int(r["open_time"].timestamp()), "entry_price": r["open_price"],
            "exit_time": int(r["close_time"].timestamp()), "exit_price": r["close_price"],
            "costs": r["fees"], "swap": r["swap"], "pnl": p,
            "stop_loss": r["stop_loss"], "take_profit": r["take_profit"],
        })
    return build_report(trades, equity, capital)


# ---------------------------------------------------------------------------
# Broker CSV import
# ---------------------------------------------------------------------------

# Normalised header -> field. Covers MetaTrader 4/5 history exports, cTrader and plain spreadsheets.
ALIASES = {
    "ticket": "ticket", "order": "ticket", "position": "ticket", "deal": "ticket", "id": "ticket", "tradeid": "ticket",
    "opentime": "open_time", "time": "open_time", "opendate": "open_time", "entrytime": "open_time",
    "openingtime": "open_time", "openingtimeutc": "open_time", "date": "open_time",
    "type": "side", "side": "side", "direction": "side", "action": "side", "buysell": "side",
    "size": "size_lots", "volume": "size_lots", "lots": "size_lots", "lot": "size_lots",
    "units": "size_oz", "quantity": "size_oz", "qty": "size_oz", "ounces": "size_oz", "oz": "size_oz",
    "item": "symbol", "symbol": "symbol", "instrument": "symbol", "market": "symbol",
    "price": "open_price", "openprice": "open_price", "entryprice": "open_price", "entry": "open_price",
    "closetime": "close_time", "closedate": "close_time", "exittime": "close_time", "closingtime": "close_time",
    "closingtimeutc": "close_time",
    "closeprice": "close_price", "exitprice": "close_price", "closingprice": "close_price",
    "sl": "stop_loss", "stoploss": "stop_loss", "tp": "take_profit", "takeprofit": "take_profit",
    "commission": "fees", "commissions": "fees", "fee": "fees", "fees": "fees",
    "swap": "swap", "swaps": "swap", "rollover": "swap", "financing": "swap",
    "comment": "notes", "notes": "notes",
}

DATE_FORMATS = ("%Y.%m.%d %H:%M:%S", "%Y.%m.%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S",
                "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M", "%Y/%m/%d %H:%M:%S",
                "%Y.%m.%d", "%Y-%m-%d")


def _norm(h: str) -> str:
    return re.sub(r"[^a-z]", "", h.lower())


def _num(v: str | None) -> float | None:
    if v is None:
        return None
    v = v.strip().replace(" ", "").replace(" ", "")
    if not v or v == "-":
        return None
    if "," in v and "." not in v:
        v = v.replace(",", ".")
    v = v.replace(",", "")
    try:
        return float(v)
    except ValueError:
        return None


def _when(v: str | None) -> datetime | None:
    if not v or not v.strip():
        return None
    v = v.strip()
    try:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    for f in DATE_FORMATS:
        try:
            return datetime.strptime(v, f).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def parse_csv(text: str, contract_size: float = 100) -> tuple[list[tuple[str | None, TradeIn]], list[str]]:
    """Returns (ticket, trade) pairs for gold trades, plus human-readable reasons for skipped rows."""
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    if not rows:
        return [], ["The file is empty"]
    # The header is the first row that names at least a side and a price.
    hi = next((i for i, r in enumerate(rows[:20])
               if {"side", "open_price"} <= {ALIASES.get(_norm(h)) for h in r}), None)
    if hi is None:
        return [], ["Couldn't find a header row with a trade type (buy/sell) and a price column"]
    fields: list[str | None] = []
    for h in rows[hi]:
        f = ALIASES.get(_norm(h))
        # MetaTrader repeats "Price": the first is the open price, the second the close price.
        if f == "open_price" and "open_price" in fields:
            f = "close_price"
        if f == "open_time" and "open_time" in fields:
            f = "close_time"
        fields.append(f if f not in fields else None)

    out, skipped = [], []
    for n, r in enumerate(rows[hi + 1:], start=hi + 2):
        rec = {f: v for f, v in zip(fields, r) if f}
        if not any(v.strip() for v in r):
            continue
        sym = rec.get("symbol", "xauusd").lower()
        if "xau" not in sym and "gold" not in sym:
            skipped.append(f"Row {n}: {rec.get('symbol')} is not gold")
            continue
        side_raw = (rec.get("side") or "").strip().lower()
        side = "long" if side_raw.startswith(("buy", "long")) else "short" if side_raw.startswith(("sell", "short")) else None
        if not side:
            skipped.append(f"Row {n}: '{rec.get('side', '')}' is not a buy or sell")
            continue
        lots, oz = _num(rec.get("size_lots")), _num(rec.get("size_oz"))
        units = oz if oz else (lots * contract_size if lots else None)
        close_time, close_price = _when(rec.get("close_time")), _num(rec.get("close_price"))
        try:
            t = TradeIn(
                side=side,
                units=units,
                open_time=_when(rec.get("open_time")),
                open_price=_num(rec.get("open_price")),
                close_time=close_time if close_price else None,
                close_price=close_price if close_time else None,
                stop_loss=_num(rec.get("stop_loss")) or None,
                take_profit=_num(rec.get("take_profit")) or None,
                fees=abs(_num(rec.get("fees")) or 0),
                swap=_num(rec.get("swap")) or 0,
                notes=(rec.get("notes") or "")[:1000],
            )
        except Exception as e:  # noqa: BLE001 - report any bad row and keep going
            msg = e.errors()[0]["msg"] if hasattr(e, "errors") else str(e)
            skipped.append(f"Row {n}: {msg}")
            continue
        out.append(((rec.get("ticket") or "").strip() or None, t))
    return out, skipped


@router.post("/import")
async def import_(
    file: UploadFile = File(...),
    contract_size: float = Form(100, gt=0, le=10_000),
    user: UserOut = Depends(current_user),
):
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "File is larger than 2 MB")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("latin-1")
    parsed, skipped = parse_csv(text, contract_size)
    imported = duplicates = 0
    with db.conn() as c:
        for ticket, t in parsed:
            if _insert(c, user.id, t, "import", ticket):
                imported += 1
            else:
                duplicates += 1
    return {"imported": imported, "duplicates": duplicates, "skipped": skipped[:50], "skipped_count": len(skipped)}
