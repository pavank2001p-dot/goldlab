from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Query

from . import config, db

router = APIRouter(prefix="/prices", tags=["prices"])

MAX_BARS = 5000


def _ts(v: int | None) -> datetime | None:
    return datetime.fromtimestamp(v, tz=timezone.utc) if v is not None else None


@router.get("/candles")
def candles(
    tf: Literal["1h", "1d"] = "1h",
    start: int | None = Query(None, description="Unix seconds, inclusive"),
    end: int | None = Query(None, description="Unix seconds, exclusive"),
    limit: int = Query(1000, ge=1, le=MAX_BARS),
):
    """Bars in ascending time order. With no start, returns the latest `limit` bars before `end`."""
    where = ["symbol = %s", "tf = %s"]
    args: list = [config.SYMBOL, tf]
    if start is not None:
        where.append("ts >= %s")
        args.append(_ts(start))
    if end is not None:
        where.append("ts < %s")
        args.append(_ts(end))
    order = "ASC" if start is not None else "DESC"
    sql = (
        "SELECT extract(epoch FROM ts)::bigint AS t, open AS o, high AS h, low AS l, close AS c, volume AS v "
        f"FROM candles WHERE {' AND '.join(where)} ORDER BY ts {order} LIMIT %s"
    )
    with db.conn() as c:
        rows = c.execute(sql, (*args, limit)).fetchall()
    if order == "DESC":
        rows.reverse()
    return {"symbol": config.SYMBOL, "tf": tf, "bars": rows}


@router.get("/summary")
def summary():
    """Latest price, daily change, data coverage and where the data came from."""
    with db.conn() as c:
        last = c.execute(
            "SELECT ts, close FROM candles WHERE symbol = %s AND tf = '1h' ORDER BY ts DESC LIMIT 1",
            (config.SYMBOL,),
        ).fetchone()
        span = c.execute(
            "SELECT min(ts) AS first, max(ts) AS last, count(*) AS n FROM candles WHERE symbol = %s AND tf = %s",
            (config.SYMBOL, "1h"),
        ).fetchone()
        prev = None
        if last:
            prev = c.execute(
                """SELECT close FROM candles WHERE symbol = %s AND tf = '1h' AND ts <= %s - interval '24 hours'
                   ORDER BY ts DESC LIMIT 1""",
                (config.SYMBOL, last["ts"]),
            ).fetchone()
    source = db.get_meta("price_source") or "none"
    updated = db.get_meta("prices_updated_at")
    if not last:
        return {"symbol": config.SYMBOL, "price": None, "source": source}
    change = last["close"] - prev["close"] if prev else None
    return {
        "symbol": config.SYMBOL,
        "price": last["close"],
        "as_of": int(last["ts"].timestamp()),
        "change_24h": change,
        "change_24h_pct": (change / prev["close"] * 100) if prev else None,
        "first_bar": int(span["first"].timestamp()),
        "hourly_bars": span["n"],
        "source": source,
        "updated_at": updated,
    }
