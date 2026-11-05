from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Query

from . import config, db

router = APIRouter(prefix="/prices", tags=["prices"])

MAX_BARS = 5000


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
):
    """Bars in ascending time order. With no start, returns the latest `limit` bars before `end`."""
    base, bucket = TIMEFRAMES[tf]
    where = ["symbol = %s", "tf = %s"]
    args: list = [config.SYMBOL, base]
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
