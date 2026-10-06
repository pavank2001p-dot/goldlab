"""Load XAU/USD prices into the candles table.

    python -m app.ingest backfill [--source dukascopy|sample] [--since 2010-01-01]
    python -m app.ingest update   [--source dukascopy|sample]

Hourly bars are the stored source of truth; daily bars are rebuilt from them so the
two timeframes always agree. A daily bar runs from 17:00 New York to 17:00 New York
(the usual forex/gold convention), stamped with the date it closes on.
"""

import argparse
import logging
import lzma
import math
import random
import struct
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from . import config, db

log = logging.getLogger("ingest")
UTC = timezone.utc
NY = ZoneInfo("America/New_York")


@dataclass
class Bar:
    ts: datetime  # open time, UTC
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


# ---------------------------------------------------------------------------
# Dukascopy (free historical feed, no API key)
# ---------------------------------------------------------------------------

DUKA_BASE = "https://datafeed.dukascopy.com/datafeed"
DUKA_POINT = 1000.0  # XAUUSD prices are stored as integers x 1000
_CANDLE = struct.Struct(">IIIIIf")  # seconds offset, open, close, low, high, volume
_TICK = struct.Struct(">IIIff")  # ms offset, ask, bid, ask volume, bid volume


def _duka_url(*parts: str) -> str:
    return "/".join([DUKA_BASE, config.SYMBOL, *parts])


def _ym(d: date) -> tuple[str, str]:
    # Dukascopy months are zero-based: January is "00".
    return f"{d.year}", f"{d.month - 1:02d}"


def _get(client: httpx.Client, url: str) -> bytes | None:
    """Fetch and decompress one .bi5 file. None when the file does not exist yet."""
    for attempt in range(4):
        try:
            r = client.get(url)
        except httpx.HTTPError as e:
            log.warning("fetch %s failed (%s), retrying", url, e)
            time.sleep(2**attempt)
            continue
        if r.status_code == 404:
            return None
        if r.status_code >= 500 or r.status_code == 429:
            time.sleep(2**attempt)
            continue
        r.raise_for_status()
        return lzma.decompress(r.content) if r.content else b""
    raise RuntimeError(f"giving up on {url}")


def parse_candles(raw: bytes, base: datetime) -> list[Bar]:
    bars = []
    for off, o, c, lo, hi, vol in _CANDLE.iter_unpack(raw):
        if vol <= 0:  # Dukascopy pads closed-market periods with flat zero-volume bars
            continue
        bars.append(
            Bar(base + timedelta(seconds=off), o / DUKA_POINT, hi / DUKA_POINT, lo / DUKA_POINT, c / DUKA_POINT, vol)
        )
    return bars


def parse_ticks_to_bar(raw: bytes, hour: datetime) -> Bar | None:
    bids = [(bid / DUKA_POINT, bv) for _, _, bid, _, bv in _TICK.iter_unpack(raw)]
    if not bids:
        return None
    prices = [p for p, _ in bids]
    return Bar(hour, prices[0], max(prices), min(prices), prices[-1], sum(v for _, v in bids))


def resample_hourly(bars: Iterable[Bar]) -> list[Bar]:
    out: dict[datetime, Bar] = {}
    for b in bars:
        h = b.ts.replace(minute=0, second=0, microsecond=0)
        cur = out.get(h)
        if cur is None:
            out[h] = Bar(h, b.open, b.high, b.low, b.close, b.volume)
        else:
            cur.high = max(cur.high, b.high)
            cur.low = min(cur.low, b.low)
            cur.close = b.close
            cur.volume += b.volume
    return [out[k] for k in sorted(out)]


def dukascopy_hourly(start: datetime, end: datetime) -> Iterator[list[Bar]]:
    """Yield hourly bars in [start, end), one chunk per month or day.

    Finished months come from one monthly hour-candle file. The current month (or a
    month whose file is not published yet) is built from daily minute files, and
    today from hourly tick files, so the latest completed hour is always included.
    """
    now = datetime.now(UTC)
    today = now.date()
    headers = {"User-Agent": "goldlab-ingest/1.0"}
    with httpx.Client(timeout=30, headers=headers, follow_redirects=True) as client:
        month = date(start.year, start.month, 1)
        while month <= end.date():
            nxt = (month.replace(day=28) + timedelta(days=4)).replace(day=1)
            month_start = datetime(month.year, month.month, 1, tzinfo=UTC)
            raw = None
            if nxt <= today:
                raw = _get(client, _duka_url(*_ym(month), "BID_candles_hour_1.bi5"))
            if raw is not None:
                yield [b for b in parse_candles(raw, month_start) if start <= b.ts < end]
            else:
                day = max(month, start.date())
                while day < nxt and day <= min(today, end.date()):
                    day_start = datetime(day.year, day.month, day.day, tzinfo=UTC)
                    y, m = _ym(day)
                    if day < today:
                        raw = _get(client, _duka_url(y, m, f"{day.day:02d}", "BID_candles_min_1.bi5"))
                        bars = resample_hourly(parse_candles(raw, day_start)) if raw else []
                    else:
                        bars = []
                        for hr in range(now.hour):  # completed hours only
                            hour = day_start + timedelta(hours=hr)
                            raw = _get(client, _duka_url(y, m, f"{day.day:02d}", f"{hr:02d}h_ticks.bi5"))
                            bar = parse_ticks_to_bar(raw, hour) if raw else None
                            if bar:
                                bars.append(bar)
                    yield [b for b in bars if start <= b.ts < end]
                    day += timedelta(days=1)
            log.info("dukascopy %s done", month.isoformat()[:7])
            month = nxt


# ---------------------------------------------------------------------------
# Sample data (offline demo): real monthly averages, synthetic hours in between
# ---------------------------------------------------------------------------

HOURLY_VOL = 0.0015  # roughly gold's typical hourly volatility


def market_open(ts: datetime) -> bool:
    """Gold trades Sunday 18:00 to Friday 17:00 New York time, with a daily 17:00-18:00 break."""
    ny = ts.astimezone(NY)
    wd, h = ny.weekday(), ny.hour  # Monday = 0
    if h == 17:
        return False
    if wd == 5:
        return False
    if wd == 4 and h >= 17:
        return False
    if wd == 6 and h < 18:
        return False
    return True


def _monthly_anchors() -> list[tuple[datetime, float]]:
    path = Path(__file__).parent / "data" / "gold_monthly.csv"
    rows = []
    for line in path.read_text().splitlines()[1:]:
        ym, price = line.split(",")
        y, m = map(int, ym.split("-"))
        # Treat each monthly average as the price in the middle of that month.
        rows.append((datetime(y, m, 15, tzinfo=UTC), float(price)))
    return rows


def _bar_from_walk(ts: datetime, open_: float, close: float, rng: random.Random) -> Bar:
    wick = abs(rng.gauss(0, HOURLY_VOL * 0.6))
    hi = max(open_, close) * (1 + wick * rng.random())
    lo = min(open_, close) * (1 - wick * rng.random())
    return Bar(ts, round(open_, 3), round(hi, 3), round(lo, 3), round(close, 3), round(rng.uniform(50, 400), 1))


def sample_hourly(start: datetime, end: datetime) -> Iterator[list[Bar]]:
    """Deterministic synthetic hours that pass through the real monthly averages."""
    anchors = _monthly_anchors()
    for (t0, p0), (t1, p1) in zip(anchors, anchors[1:] + [(None, None)]):
        if t1 is None:  # past the last anchor: free random walk up to now
            t1 = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
        if t1 <= start or t0 >= end:
            continue
        rng = random.Random(int(t0.timestamp()))
        hours = [t0 + timedelta(hours=i) for i in range(int((t1 - t0).total_seconds() // 3600))]
        hours = [h for h in hours if market_open(h)]
        if not hours:
            continue
        # Brownian bridge in log space from p0 to p1 (or a plain walk for the open-ended tail).
        steps = [rng.gauss(0, HOURLY_VOL) for _ in hours]
        drift = 0.0 if p1 is None else (math.log(p1 / p0) - sum(steps)) / len(steps)
        price, chunk = p0, []
        for h, s in zip(hours, steps):
            nxt = price * math.exp(s + drift)
            if start <= h < end:
                chunk.append(_bar_from_walk(h, price, nxt, rng))
            price = nxt
        yield chunk


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def upsert(bars: list[Bar], tf: str = "1h") -> int:
    if not bars:
        return 0
    with db.conn() as c, c.cursor() as cur:
        cur.executemany(
            """INSERT INTO candles (symbol, tf, ts, open, high, low, close, volume)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (symbol, tf, ts) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high,
                 low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume""",
            [(config.SYMBOL, tf, b.ts, b.open, b.high, b.low, b.close, b.volume) for b in bars],
        )
    return len(bars)


def rebuild_daily(since: datetime) -> None:
    """Recompute daily bars from hourly ones, for trading days touching `since` onward."""
    with db.conn() as c:
        c.execute(
            """
            WITH h AS (
              SELECT ts, open, high, low, close, volume,
                     ((ts AT TIME ZONE 'America/New_York') + interval '7 hours')::date AS d
              FROM candles WHERE symbol = %(s)s AND tf = '1h' AND ts >= %(since)s - interval '2 days'
            )
            INSERT INTO candles (symbol, tf, ts, open, high, low, close, volume)
            SELECT %(s)s, '1d', d::timestamp AT TIME ZONE 'UTC',
                   (array_agg(open ORDER BY ts))[1], max(high), min(low),
                   (array_agg(close ORDER BY ts DESC))[1], sum(volume)
            FROM h GROUP BY d
            ON CONFLICT (symbol, tf, ts) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high,
              low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume
            """,
            {"s": config.SYMBOL, "since": since},
        )


def _last_hour() -> datetime | None:
    with db.conn() as c:
        row = c.execute(
            "SELECT max(ts) AS ts FROM candles WHERE symbol = %s AND tf = '1h'", (config.SYMBOL,)
        ).fetchone()
    return row["ts"]


def load(source: str, start: datetime, end: datetime) -> int:
    fetch = dukascopy_hourly if source == "dukascopy" else sample_hourly
    previous = db.get_meta("price_source")
    if previous and previous != source:
        # Never mix sources: replace demo data entirely once real data arrives (and vice versa).
        with db.conn() as c:
            c.execute("DELETE FROM candles WHERE symbol = %s", (config.SYMBOL,))
    total = 0
    for chunk in fetch(start, end):
        total += upsert(chunk)
    rebuild_daily(start)
    db.set_meta("price_source", source)
    db.set_meta("prices_updated_at", datetime.now(UTC).isoformat(timespec="seconds"))
    return total


def backfill(source: str, since: date) -> int:
    start = datetime(since.year, since.month, since.day, tzinfo=UTC)
    return load(source, start, datetime.now(UTC))


def update(source: str) -> int:
    """Refresh from a day before the newest stored hour (or backfill from 2010 if empty)."""
    last = _last_hour()
    if last is None or db.get_meta("price_source") != source:
        return backfill(source, date(2010, 1, 1))
    return load(source, last - timedelta(days=1), datetime.now(UTC))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["backfill", "update"])
    p.add_argument("--source", choices=["dukascopy", "sample"], default=config.PRICE_SOURCE)
    p.add_argument("--since", type=date.fromisoformat, default=date(2010, 1, 1))
    a = p.parse_args()
    db.migrate()
    n = backfill(a.source, a.since) if a.command == "backfill" else update(a.source)
    log.info("%s: stored %d hourly bars from %s", a.command, n, a.source)
    db.close()


if __name__ == "__main__":
    main()
