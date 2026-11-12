"""Load market prices into the candles table (gold plus the markets in app.instruments).

    python -m app.ingest backfill [--source dukascopy|sample] [--since 2010-01-01] [--symbol XAUUSD]
    python -m app.ingest update   [--source dukascopy|sample]   (every enabled market)

Long-run history: monthly prices since 1833 (bundled, public domain) are stored as '1mo' bars
and fill the monthly chart before the first daily bar. See load_monthly_history.

Hourly bars are the stored source of truth; daily bars are rebuilt from them so the
two timeframes always agree. Minute bars (last MINUTE_DAYS) and one-second bars (last
SECOND_DAYS) are kept for short-term charts; other timeframes are aggregated on request. A daily bar runs from 17:00 New York to 17:00 New York
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
from .instruments import ENABLED, GOLD, Instrument, fit_point

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
DUKA_POINT = 1000.0  # XAUUSD prices are stored as integers x 1000; other markets are checked, see duka_point
_CANDLE = struct.Struct(">IIIIIf")  # seconds offset, open, close, low, high, volume
_TICK = struct.Struct(">IIIff")  # ms offset, ask, bid, ask volume, bid volume


def _duka_url(*parts: str, symbol: str = config.SYMBOL) -> str:
    return "/".join([DUKA_BASE, symbol, *parts])


def _key(name: str, inst: Instrument) -> str:
    """Meta keys for gold keep their original names; other markets get their symbol appended."""
    return name if inst.symbol == GOLD.symbol else f"{name}:{inst.symbol}"


def duka_point(client: httpx.Client, inst: Instrument) -> float:
    """What the feed's integer prices are divided by for this market. The feed doesn't publish it,
    so it is worked out once from recent minute bars against the market's rough price, and saved."""
    if inst.symbol == GOLD.symbol:
        return DUKA_POINT
    key = _key("duka_point", inst)
    saved = db.get_meta(key)
    if saved:
        return float(saved)
    today = datetime.now(UTC).date()
    for back in range(1, 15):
        day = today - timedelta(days=back)
        y, m = _ym(day)
        raw = _get(client, _duka_url(y, m, f"{day.day:02d}", "BID_candles_min_1.bi5", symbol=inst.symbol))
        closes = sorted(c for _, _, c, _, _, v in _CANDLE.iter_unpack(raw or b"") if v > 0)
        if closes:
            point = fit_point(closes[len(closes) // 2], inst.ref_price)
            db.set_meta(key, repr(point))
            log.info("%s: feed prices are divided by %g", inst.symbol, point)
            return point
    raise RuntimeError(f"No recent {inst.symbol} prices to check the feed's scale against")


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


def parse_candles(raw: bytes, base: datetime, point: float = DUKA_POINT) -> list[Bar]:
    bars = []
    for off, o, c, lo, hi, vol in _CANDLE.iter_unpack(raw):
        if vol <= 0:  # Dukascopy pads closed-market periods with flat zero-volume bars
            continue
        bars.append(
            Bar(base + timedelta(seconds=off), o / point, hi / point, lo / point, c / point, vol)
        )
    return bars


def parse_ticks_to_bar(raw: bytes, hour: datetime, point: float = DUKA_POINT) -> Bar | None:
    bids = [(bid / point, bv) for _, _, bid, _, bv in _TICK.iter_unpack(raw)]
    if not bids:
        return None
    prices = [p for p, _ in bids]
    return Bar(hour, prices[0], max(prices), min(prices), prices[-1], sum(v for _, v in bids))


def parse_ticks_to_bars(raw: bytes, hour: datetime, step: int, point: float = DUKA_POINT) -> list[Bar]:
    """Bid ticks for one hour grouped into bars of `step` seconds."""
    out: dict[int, Bar] = {}
    for ms, _, bid, _, bv in _TICK.iter_unpack(raw):
        k = ms // 1000 // step * step
        p = bid / point
        cur = out.get(k)
        if cur is None:
            out[k] = Bar(hour + timedelta(seconds=k), p, p, p, p, bv)
        else:
            cur.high, cur.low, cur.close = max(cur.high, p), min(cur.low, p), p
            cur.volume += bv
    return [out[k] for k in sorted(out)]


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


def dukascopy_hourly(start: datetime, end: datetime, inst: Instrument = GOLD) -> Iterator[list[Bar]]:
    """Yield hourly bars in [start, end), one chunk per month or day.

    Finished months come from one monthly hour-candle file. The current month (or a
    month whose file is not published yet) is built from daily minute files, and
    today from hourly tick files, so the latest completed hour is always included.
    """
    now = datetime.now(UTC)
    today = now.date()
    headers = {"User-Agent": "goldlab-ingest/1.0"}
    with httpx.Client(timeout=30, headers=headers, follow_redirects=True) as client:
        point, sym = duka_point(client, inst), inst.symbol
        month = date(start.year, start.month, 1)
        while month <= end.date():
            nxt = (month.replace(day=28) + timedelta(days=4)).replace(day=1)
            month_start = datetime(month.year, month.month, 1, tzinfo=UTC)
            raw = None
            if nxt <= today:
                raw = _get(client, _duka_url(*_ym(month), "BID_candles_hour_1.bi5", symbol=sym))
            if raw is not None:
                yield [b for b in parse_candles(raw, month_start, point) if start <= b.ts < end]
            elif nxt <= today - timedelta(days=7):
                pass  # a month long finished with no file: the feed has no data that far back
            else:
                day = max(month, start.date())
                while day < nxt and day <= min(today, end.date()):
                    day_start = datetime(day.year, day.month, day.day, tzinfo=UTC)
                    y, m = _ym(day)
                    if day < today:
                        raw = _get(client, _duka_url(y, m, f"{day.day:02d}", "BID_candles_min_1.bi5", symbol=sym))
                        bars = resample_hourly(parse_candles(raw, day_start, point)) if raw else []
                    else:
                        bars = []
                        for hr in range(now.hour):  # completed hours only
                            hour = day_start + timedelta(hours=hr)
                            raw = _get(client, _duka_url(y, m, f"{day.day:02d}", f"{hr:02d}h_ticks.bi5", symbol=sym))
                            bar = parse_ticks_to_bar(raw, hour, point) if raw else None
                            if bar:
                                bars.append(bar)
                    yield [b for b in bars if start <= b.ts < end]
                    day += timedelta(days=1)
            log.info("dukascopy %s %s done", sym, month.isoformat()[:7])
            month = nxt


def _hours(start: datetime, end: datetime) -> Iterator[datetime]:
    """Completed hours in [start, end)."""
    h = start.replace(minute=0, second=0, microsecond=0)
    last = min(end, datetime.now(UTC)).replace(minute=0, second=0, microsecond=0)
    while h < last:
        yield h
        h += timedelta(hours=1)


def dukascopy_minutes(start: datetime, end: datetime, inst: Instrument = GOLD) -> Iterator[list[Bar]]:
    """Minute bars in [start, end): a daily minute file for past days, hourly tick files for today."""
    today = datetime.now(UTC).date()
    headers = {"User-Agent": "goldlab-ingest/1.0"}
    with httpx.Client(timeout=30, headers=headers, follow_redirects=True) as client:
        point, sym = duka_point(client, inst), inst.symbol
        day = start.date()
        while day <= min(today, end.date()):
            day_start = datetime(day.year, day.month, day.day, tzinfo=UTC)
            y, m = _ym(day)
            raw = None
            if day < today:
                raw = _get(client, _duka_url(y, m, f"{day.day:02d}", "BID_candles_min_1.bi5", symbol=sym))
            if raw is not None:
                bars = parse_candles(raw, day_start, point)
            else:  # today, or a day whose minute file isn't published yet
                bars = []
                for hour in _hours(max(start, day_start), min(end, day_start + timedelta(days=1))):
                    raw = _get(client, _duka_url(y, m, f"{day.day:02d}", f"{hour.hour:02d}h_ticks.bi5", symbol=sym))
                    bars += parse_ticks_to_bars(raw, hour, 60, point) if raw else []
            yield [b for b in bars if start <= b.ts < end]
            day += timedelta(days=1)


def dukascopy_seconds(start: datetime, end: datetime, inst: Instrument = GOLD) -> Iterator[list[Bar]]:
    """One-second bars from hourly tick files. The feed publishes each hour once it has ended."""
    headers = {"User-Agent": "goldlab-ingest/1.0"}
    with httpx.Client(timeout=30, headers=headers, follow_redirects=True) as client:
        point = duka_point(client, inst)
        for hour in _hours(start, end):
            y, m = _ym(hour.date())
            raw = _get(client, _duka_url(y, m, f"{hour.day:02d}", f"{hour.hour:02d}h_ticks.bi5", symbol=inst.symbol))
            if raw:
                yield [b for b in parse_ticks_to_bars(raw, hour, 1, point) if start <= b.ts < end]


# ---------------------------------------------------------------------------
# Sample data (offline demo): real monthly averages, synthetic hours in between
# ---------------------------------------------------------------------------

HOURLY_VOL = 0.0015  # roughly gold's typical hourly volatility


def market_open(ts: datetime) -> bool:
    """Gold trades Sunday 18:00 to Friday 17:00 New York time, with a daily 17:00-18:00 break."""
    return GOLD.is_open(ts)


def _digits(inst: Instrument) -> int:
    return max(3, inst.decimals + 1)


def _monthly_anchors() -> list[tuple[datetime, float]]:
    path = Path(__file__).parent / "data" / "gold_monthly.csv"
    rows = []
    for line in path.read_text().splitlines()[1:]:
        ym, price = line.split(",")
        y, m = map(int, ym.split("-"))
        # Treat each monthly average as the price in the middle of that month.
        rows.append((datetime(y, m, 15, tzinfo=UTC), float(price)))
    return rows


def _bar_from_walk(ts: datetime, open_: float, close: float, rng: random.Random, d: int = 3) -> Bar:
    wick = abs(rng.gauss(0, HOURLY_VOL * 0.6))
    hi = max(open_, close) * (1 + wick * rng.random())
    lo = min(open_, close) * (1 - wick * rng.random())
    return Bar(ts, round(open_, d), round(hi, d), round(lo, d), round(close, d), round(rng.uniform(50, 400), 1))


def sample_hourly(start: datetime, end: datetime, inst: Instrument = GOLD) -> Iterator[list[Bar]]:
    """Deterministic synthetic hours that pass through the real monthly averages of gold. Other
    markets reuse gold's path scaled to their own rough price, and their own trading hours: demo
    data only, never shown as real."""
    anchors = _monthly_anchors()
    if inst.symbol != GOLD.symbol:
        scale = inst.ref_price / anchors[-1][1]
        anchors = [(t, p * scale) for t, p in anchors]
    d = _digits(inst)
    for (t0, p0), (t1, p1) in zip(anchors, anchors[1:] + [(None, None)]):
        if t1 is None:  # past the last anchor: free random walk up to now
            t1 = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
        if t1 <= start or t0 >= end:
            continue
        rng = random.Random(int(t0.timestamp()))
        hours = [t0 + timedelta(hours=i) for i in range(int((t1 - t0).total_seconds() // 3600))]
        hours = [h for h in hours if inst.is_open(h)]
        if not hours:
            continue
        # Brownian bridge in log space from p0 to p1 (or a plain walk for the open-ended tail).
        steps = [rng.gauss(0, HOURLY_VOL) for _ in hours]
        drift = 0.0 if p1 is None else (math.log(p1 / p0) - sum(steps)) / len(steps)
        price, chunk = p0, []
        for h, s in zip(hours, steps):
            nxt = price * math.exp(s + drift)
            if start <= h < end:
                chunk.append(_bar_from_walk(h, price, nxt, rng, d))
            price = nxt
        yield chunk


def subdivide(bar: Bar, n: int, step: int, rng: random.Random, d: int = 3) -> list[Bar]:
    """Split one bar into n bars of `step` seconds along a random path from its open to its
    close, kept inside the bar's high and low."""
    scale = (bar.high - bar.low) / math.sqrt(n) * 0.6
    steps = [rng.gauss(0, scale) for _ in range(n)]
    pull = (sum(steps) - (bar.close - bar.open)) / n  # bridge: the path ends at the close
    path, x = [bar.open], bar.open
    for z in steps:
        x += z - pull
        path.append(min(max(x, bar.low), bar.high))
    path[-1] = bar.close
    out = []
    for i in range(n):
        o, c = path[i], path[i + 1]
        w = abs(rng.gauss(0, scale * 0.3))
        out.append(Bar(bar.ts + timedelta(seconds=i * step), round(o, d), round(min(max(o, c) + w, bar.high), d),
                       round(max(min(o, c) - w, bar.low), d), round(c, d), round(bar.volume / n, 2)))
    return out


def sample_fine(start: datetime, end: datetime, step: int, inst: Instrument = GOLD) -> Iterator[list[Bar]]:
    """Demo minute (step=60) or second (step=1) bars, split from the sample hours."""
    d = _digits(inst)
    for chunk in sample_hourly(start.replace(minute=0, second=0, microsecond=0), end, inst):
        out = []
        for h in chunk:
            rng = random.Random(int(h.ts.timestamp()) * 7 + step)
            minutes = subdivide(h, 60, 60, rng, d)
            out += minutes if step == 60 else [s for m in minutes for s in subdivide(m, 60, 1, rng, d)]
        yield [b for b in out if start <= b.ts < end]


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Monthly history since 1833
# ---------------------------------------------------------------------------

HISTORY_CSV = Path(__file__).parent / "data" / "gold_history_monthly.csv"


def monthly_history() -> list[Bar]:
    """Monthly gold prices in USD per ounce since 1833, from the public-domain datahub.io
    "gold-prices" dataset: annual averages from Timothy Green's tables to 1959 (the same value
    for every month of a year), then World Bank monthly averages. Each month has one price, so a
    bar opens at the previous month's price and closes at this month's."""
    bars, prev = [], None
    for line in HISTORY_CSV.read_text().splitlines()[1:]:
        ym, price = line.split(",")
        y, m = map(int, ym.split("-"))
        p = float(price)
        o = prev if prev is not None else p
        bars.append(Bar(datetime(y, m, 1, tzinfo=UTC), o, max(o, p), min(o, p), p))
        prev = p
    return bars


def load_monthly_history() -> int:
    """Store the monthly history (idempotent; a few thousand rows)."""
    return upsert(monthly_history(), "1mo")


def upsert(bars: list[Bar], tf: str = "1h", symbol: str = config.SYMBOL) -> int:
    if not bars:
        return 0
    with db.conn() as c, c.cursor() as cur:
        cur.executemany(
            """INSERT INTO candles (symbol, tf, ts, open, high, low, close, volume)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (symbol, tf, ts) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high,
                 low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume""",
            [(symbol, tf, b.ts, b.open, b.high, b.low, b.close, b.volume) for b in bars],
        )
    return len(bars)


# The trading day an hourly bar belongs to: 17:00 New York to 17:00 New York (forex, metals,
# energy, indices, stocks; US stocks close at 16:00 so their day is the calendar day), or
# midnight to midnight UTC for crypto, which never closes.
DAY_SQL = {
    "ny17": "((ts AT TIME ZONE 'America/New_York') + interval '7 hours')::date",
    "utc": "(ts AT TIME ZONE 'UTC')::date",
}


def rebuild_daily(since: datetime, inst: Instrument = GOLD) -> None:
    """Recompute daily bars from hourly ones, for trading days touching `since` onward."""
    with db.conn() as c:
        c.execute(
            f"""
            WITH h AS (
              SELECT ts, open, high, low, close, volume, {DAY_SQL[inst.day]} AS d
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
            {"s": inst.symbol, "since": since},
        )


def _last_hour(inst: Instrument = GOLD) -> datetime | None:
    with db.conn() as c:
        row = c.execute(
            "SELECT max(ts) AS ts FROM candles WHERE symbol = %s AND tf = '1h'", (inst.symbol,)
        ).fetchone()
    return row["ts"]


def _keeps_seconds(inst: Instrument) -> bool:
    return inst.symbol in config.SECOND_SYMBOLS


def load_fine(source: str, inst: Instrument = GOLD) -> int:
    """Bring minute and second bars up to date and drop those past their retention window."""
    now = datetime.now(UTC)
    total = 0
    for tf, days, step, fetch in (
        ("1m", config.MINUTE_DAYS if inst.symbol == GOLD.symbol else min(config.MINUTE_DAYS, config.MARKET_MINUTE_DAYS),
         60, dukascopy_minutes),
        ("1s", config.SECOND_DAYS if _keeps_seconds(inst) else 0, 1, dukascopy_seconds),
    ):
        if days <= 0:
            continue
        floor = now - timedelta(days=days)
        # Track how far this feed has got separately from what is stored: live quotes also
        # write recent bars, and must not make this skip hours it hasn't fetched yet.
        key = _key(f"fine_{source}_{tf}", inst)
        done = db.get_meta(key)
        # Re-fetch the hour before too, in case the feed published it late.
        start = max(floor, datetime.fromisoformat(done) - timedelta(hours=1)) if done else floor
        chunks = fetch(start, now, inst) if source == "dukascopy" else sample_fine(start, now, step, inst)
        for chunk in chunks:
            total += upsert(chunk, tf, inst.symbol)
        db.set_meta(key, now.replace(minute=0, second=0, microsecond=0).isoformat())
        with db.conn() as c:
            c.execute("DELETE FROM candles WHERE symbol = %s AND tf = %s AND ts < %s", (inst.symbol, tf, floor))
    return total


def _load_fine_safely(source: str, inst: Instrument = GOLD) -> None:
    # Short-timeframe data is a bonus; a feed hiccup there must not stop hourly updates.
    try:
        load_fine(source, inst)
    except Exception:
        log.exception("%s minute/second update failed", inst.symbol)


def load(source: str, start: datetime, end: datetime, inst: Instrument = GOLD) -> int:
    fetch = dukascopy_hourly if source == "dukascopy" else sample_hourly
    previous = db.get_meta(_key("price_source", inst))
    if previous and previous != source:
        # Never mix sources: replace demo data entirely once real data arrives (and vice versa).
        with db.conn() as c:
            c.execute("DELETE FROM candles WHERE symbol = %s AND tf <> '1mo'", (inst.symbol,))
    total = 0
    for chunk in fetch(start, end, inst):
        total += upsert(chunk, "1h", inst.symbol)
    rebuild_daily(start, inst)
    db.set_meta(_key("price_source", inst), source)
    db.set_meta(_key("prices_updated_at", inst), datetime.now(UTC).isoformat(timespec="seconds"))
    return total


def backfill(source: str, since: date, inst: Instrument = GOLD) -> int:
    start = datetime(since.year, since.month, since.day, tzinfo=UTC)
    n = load(source, start, datetime.now(UTC), inst)
    _load_fine_safely(source, inst)
    return n


def _first_hour() -> datetime | None:
    with db.conn() as c:
        row = c.execute("SELECT min(ts) AS t FROM candles WHERE symbol = %s AND tf = '1h'", (config.SYMBOL,)).fetchone()
    return row["t"] if row else None


def extend_history(source: str) -> int:
    """Once, fetch gold's hourly history from HISTORY_SINCE up to the oldest stored hour, so
    databases first filled from 2010 reach back as far as the feed goes."""
    since = config.HISTORY_SINCE
    first = _first_hour()
    if source != "dukascopy" or first is None or db.get_meta("history_since") == since.isoformat():
        return 0
    start = datetime(since.year, since.month, since.day, tzinfo=UTC)
    n = load(source, start, first, GOLD) if first > start + timedelta(days=7) else 0
    db.set_meta("history_since", since.isoformat())
    log.info("extended hourly history back to %s: %d bars", since, n)
    return n


def _history_start(source: str, inst: Instrument) -> date:
    if inst.symbol != GOLD.symbol:
        return config.MARKET_HISTORY_SINCE
    return config.HISTORY_SINCE if source == "dukascopy" else date(2010, 1, 1)


def update(source: str, inst: Instrument = GOLD) -> int:
    """Refresh one market from a day before its newest stored hour (or backfill it if empty)."""
    last = _last_hour(inst)
    if last is None or db.get_meta(_key("price_source", inst)) != source:
        n = backfill(source, _history_start(source, inst), inst)
        if source == "dukascopy" and inst.symbol == GOLD.symbol:
            db.set_meta("history_since", config.HISTORY_SINCE.isoformat())
        return n
    n = load(source, last - timedelta(days=1), datetime.now(UTC), inst)
    _load_fine_safely(source, inst)
    return n + (extend_history(source) if inst.symbol == GOLD.symbol else 0)


def update_all(source: str) -> int:
    """Refresh every enabled market, gold first. One market failing doesn't stop the others."""
    total = 0
    for inst in ENABLED:
        try:
            total += update(source, inst)
        except Exception:
            log.exception("%s price update failed", inst.symbol)
    return total


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["backfill", "update"])
    p.add_argument("--source", choices=["dukascopy", "sample"], default=config.PRICE_SOURCE)
    p.add_argument("--since", type=date.fromisoformat, default=None)
    p.add_argument("--symbol", default=GOLD.symbol)
    a = p.parse_args()
    db.migrate()
    load_monthly_history()
    if a.command == "backfill":
        from .instruments import get
        inst = get(a.symbol)
        n = backfill(a.source, a.since or _history_start(a.source, inst), inst)
    else:
        n = update_all(a.source)
    log.info("%s: stored %d hourly bars from %s", a.command, n, a.source)
    db.close()


if __name__ == "__main__":
    main()
