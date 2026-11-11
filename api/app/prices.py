from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from . import config, db
from . import instruments as ins

router = APIRouter(prefix="/prices", tags=["prices"])

MAX_BARS = 5000


def market(symbol: str | None) -> ins.Instrument:
    """The instrument for a request's symbol, or a 404 naming it."""
    try:
        return ins.get(symbol)
    except KeyError:
        raise HTTPException(404, f"Unknown market {symbol}. See /prices/markets for the list.")


@router.get("/markets")
def markets():
    """Every market on offer, grouped by asset class in display order, with its rules and latest price."""
    with db.conn() as c:
        rows = c.execute(
            """SELECT DISTINCT ON (symbol) symbol, close, ts FROM candles WHERE tf = '1h' AND symbol = ANY(%s)
               ORDER BY symbol, ts DESC""", ([i.symbol for i in ins.ENABLED],)).fetchall()
    last = {r["symbol"]: r for r in rows}
    out = []
    for i in ins.ENABLED:
        r = last.get(i.symbol)
        out.append({**i.public(), "price": r["close"] if r else None,
                    "as_of": int(r["ts"].timestamp()) if r else None,
                    "has_seconds": i.symbol in config.SECOND_SYMBOLS,
                    "has_history": i.symbol == ins.GOLD.symbol})
    return {"default": ins.DEFAULT, "classes": ins.CLASSES, "markets": out}


def _ts(v: int | None) -> datetime | None:
    return datetime.fromtimestamp(v, tz=timezone.utc) if v is not None else None


# Chart timeframe -> (stored timeframe it is built from, bucket). A bucket in seconds groups
# bars into fixed UTC slots; "week" and "month" group daily bars by calendar week and month.
TIMEFRAMES: dict[str, tuple[str, int | str | None]] = {
    "1s": ("1s", None), "5s": ("1s", 5), "15s": ("1s", 15), "30s": ("1s", 30),
    "1m": ("1m", None), "5m": ("1m", 300), "15m": ("1m", 900), "30m": ("1m", 1800),
    "1h": ("1h", None), "4h": ("1h", 14400),
    "1d": ("1d", None), "1w": ("1d", "week"), "1mo": ("1d", "month"),
}
Tf = Literal["1s", "5s", "15s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1mo"]


@router.get("/candles")
def candles(
    tf: Tf = "1h",
    start: int | None = Query(None, description="Unix seconds, inclusive"),
    end: int | None = Query(None, description="Unix seconds, exclusive"),
    limit: int = Query(1000, ge=1, le=MAX_BARS),
    symbol: str = config.SYMBOL,
):
    """Bars in ascending time order. With no start, returns the latest `limit` bars before `end`."""
    inst = market(symbol)
    base, bucket = TIMEFRAMES[tf]
    where = ["symbol = %s", "tf = %s"]
    args: list = [inst.symbol, base]
    if start is not None:
        where.append("ts >= %s")
        args.append(_ts(start))
    if end is not None:
        where.append("ts < %s")
        args.append(_ts(end))
    order = "ASC" if start is not None else "DESC"
    if bucket is None:
        sql = (
            "SELECT extract(epoch FROM ts)::bigint AS t, open AS o, high AS h, low AS l, close AS c, volume AS v "
            f"FROM candles WHERE {' AND '.join(where)} ORDER BY ts {order} LIMIT %s"
        )
    else:
        if isinstance(bucket, int):
            slot = f"to_timestamp(floor(extract(epoch FROM ts) / {bucket}) * {bucket})"
        else:
            slot = f"date_trunc('{bucket}', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
        sql = (
            f"SELECT extract(epoch FROM {slot})::bigint AS t, "
            "(array_agg(open ORDER BY ts))[1] AS o, max(high) AS h, min(low) AS l, "
            "(array_agg(close ORDER BY ts DESC))[1] AS c, sum(volume) AS v "
            f"FROM candles WHERE {' AND '.join(where)} GROUP BY 1 ORDER BY 1 {order} LIMIT %s"
        )
    with db.conn() as c:
        rows = c.execute(sql, (*args, limit)).fetchall()
        if tf == "1mo" and inst.symbol == ins.GOLD.symbol:
            rows = _with_history(c, rows, where, args, order, limit)
    if order == "DESC":
        rows.reverse()
    return {"symbol": inst.symbol, "tf": tf, "bars": rows}


def _with_history(c, rows: list[dict], where: list[str], args: list, order: str, limit: int) -> list[dict]:
    """Months before the first daily bar come from the stored monthly history (since 1833)."""
    first = c.execute("SELECT min(ts) AS t FROM candles WHERE symbol = %s AND tf = '1d'", (config.SYMBOL,)).fetchone()["t"]
    hist_where = [w for w in where if w != "tf = %s"] + ["tf = '1mo'"]
    hist_args = [a for i, a in enumerate(args) if i != 1]  # drop the tf argument
    if first is not None:
        hist_where.append("ts < date_trunc('month', %s AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")
        hist_args.append(first)
    hist = c.execute(
        "SELECT extract(epoch FROM ts)::bigint AS t, open AS o, high AS h, low AS l, close AS c, volume AS v "
        f"FROM candles WHERE {' AND '.join(hist_where)} ORDER BY ts {order} LIMIT %s",
        (*hist_args, limit),
    ).fetchall()
    merged = sorted(rows + hist, key=lambda r: r["t"], reverse=order == "DESC")
    return merged[:limit]


@router.get("/summary")
def summary(symbol: str = config.SYMBOL):
    """Latest price, daily change, data coverage and where the data came from."""
    inst = market(symbol)
    with db.conn() as c:
        last = c.execute(
            "SELECT ts, close FROM candles WHERE symbol = %s AND tf = '1h' ORDER BY ts DESC LIMIT 1",
            (inst.symbol,),
        ).fetchone()
        span = c.execute(
            "SELECT min(ts) AS first, max(ts) AS last, count(*) AS n FROM candles WHERE symbol = %s AND tf = %s",
            (inst.symbol, "1h"),
        ).fetchone()
        monthly = c.execute("SELECT min(ts) AS first FROM candles WHERE symbol = %s AND tf = '1mo'",
                            (inst.symbol,)).fetchone()
        prev = None
        if last:
            prev = c.execute(
                """SELECT close FROM candles WHERE symbol = %s AND tf = '1h' AND ts <= %s - interval '24 hours'
                   ORDER BY ts DESC LIMIT 1""",
                (inst.symbol, last["ts"]),
            ).fetchone()
    key = (lambda k: k) if inst.symbol == ins.GOLD.symbol else (lambda k: f"{k}:{inst.symbol}")
    source = db.get_meta(key("price_source")) or "none"
    updated = db.get_meta(key("prices_updated_at"))
    if not last:
        return {"symbol": inst.symbol, "name": inst.name, "price": None, "source": source}
    change = last["close"] - prev["close"] if prev else None
    return {
        "symbol": inst.symbol,
        "name": inst.name,
        "price": last["close"],
        "as_of": int(last["ts"].timestamp()),
        "change_24h": change,
        "change_24h_pct": (change / prev["close"] * 100) if prev else None,
        "first_bar": int(span["first"].timestamp()),
        "hourly_bars": span["n"],
        "first_month": int(monthly["first"].timestamp()) if monthly and monthly["first"] else None,
        "source": source,
        "updated_at": updated,
    }
