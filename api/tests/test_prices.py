import lzma
from datetime import date, datetime, timedelta, timezone

from app import ingest

UTC = timezone.utc


def test_parse_dukascopy_candles_skips_closed_hours():
    base = datetime(2024, 1, 1, tzinfo=UTC)
    raw = ingest._CANDLE.pack(0, 2063455, 2064000, 2062000, 2065100, 12.5)
    raw += ingest._CANDLE.pack(3600, 2064000, 2064000, 2064000, 2064000, 0.0)
    data = lzma.decompress(lzma.compress(raw, format=lzma.FORMAT_ALONE))
    bars = ingest.parse_candles(data, base)
    assert len(bars) == 1
    b = bars[0]
    assert (b.ts, b.open, b.high, b.low, b.close) == (base, 2063.455, 2065.1, 2062.0, 2064.0)


def test_ticks_to_bar_uses_bids():
    hour = datetime(2024, 1, 2, 10, tzinfo=UTC)
    raw = ingest._TICK.pack(0, 2050500, 2050000, 1.0, 2.0) + ingest._TICK.pack(5000, 2052500, 2052000, 1.0, 3.0)
    raw += ingest._TICK.pack(9000, 2049500, 2049000, 1.0, 1.0)
    b = ingest.parse_ticks_to_bar(raw, hour)
    assert (b.open, b.high, b.low, b.close, b.volume) == (2050.0, 2052.0, 2049.0, 2049.0, 6.0)


def test_market_hours():
    assert ingest.market_open(datetime(2024, 1, 3, 15, tzinfo=UTC))  # Wednesday
    assert not ingest.market_open(datetime(2024, 1, 6, 12, tzinfo=UTC))  # Saturday
    assert not ingest.market_open(datetime(2024, 1, 7, 20, tzinfo=UTC))  # Sunday 15:00 NY
    assert ingest.market_open(datetime(2024, 1, 7, 23, tzinfo=UTC))  # Sunday 18:00 NY


def test_sample_load_and_candles_api(client):
    ingest.backfill("sample", date(2024, 1, 1))
    r = client.get("/prices/candles", params={"tf": "1d", "limit": 10})
    bars = r.json()["bars"]
    assert len(bars) == 10
    assert [b["t"] for b in bars] == sorted(b["t"] for b in bars)
    assert all(b["l"] <= min(b["o"], b["c"]) and b["h"] >= max(b["o"], b["c"]) for b in bars)

    start = int(datetime(2024, 3, 4, tzinfo=UTC).timestamp())
    hourly = client.get("/prices/candles", params={"tf": "1h", "start": start, "limit": 24}).json()["bars"]
    assert hourly[0]["t"] >= start and len(hourly) == 24

    # No Saturday daily bars: a trading day is stamped with the date it closes on.
    days = client.get("/prices/candles", params={"tf": "1d", "limit": 5000}).json()["bars"]
    assert not [b for b in days if datetime.fromtimestamp(b["t"], UTC).weekday() == 5]

    s = client.get("/prices/summary").json()
    assert s["source"] == "sample" and s["price"] > 0 and s["change_24h"] is not None


def test_daily_matches_hourly(client):
    ingest.backfill("sample", date(2024, 6, 1))
    day = client.get("/prices/candles", params={"tf": "1d", "start": int(datetime(2024, 6, 12, tzinfo=UTC).timestamp()), "limit": 1}).json()["bars"][0]
    # Trading day 2024-06-12 = 17:00 NY Jun 11 (21:00 UTC, summer time) to 17:00 NY Jun 12.
    s = int(datetime(2024, 6, 11, 21, tzinfo=UTC).timestamp())
    hours = client.get("/prices/candles", params={"tf": "1h", "start": s, "end": s + 86400, "limit": 48}).json()["bars"]
    assert day["o"] == hours[0]["o"] and day["c"] == hours[-1]["c"]
    assert day["h"] == max(h["h"] for h in hours) and day["l"] == min(h["l"] for h in hours)


def test_switching_source_replaces_data(client, monkeypatch):
    ingest.backfill("sample", date(2026, 9, 1))
    real = ingest.Bar(datetime(2026, 9, 2, 14, tzinfo=UTC), 2500, 2501, 2499, 2500.5, 10)
    monkeypatch.setattr(ingest, "dukascopy_hourly", lambda start, end: iter([[real]]))
    ingest.backfill("dukascopy", date(2026, 9, 1))
    bars = client.get("/prices/candles", params={"tf": "1h", "limit": 5000}).json()["bars"]
    assert len(bars) == 1 and bars[0]["c"] == 2500.5
    assert client.get("/prices/summary").json()["source"] == "dukascopy"
