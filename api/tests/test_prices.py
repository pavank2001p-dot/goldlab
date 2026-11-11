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
    monkeypatch.setattr(ingest, "dukascopy_hourly", lambda start, end, i=None: iter([[real]]))
    monkeypatch.setattr(ingest, "dukascopy_minutes", lambda start, end, i=None: iter([]))
    monkeypatch.setattr(ingest, "dukascopy_seconds", lambda start, end, i=None: iter([]))
    ingest.backfill("dukascopy", date(2026, 9, 1))
    bars = client.get("/prices/candles", params={"tf": "1h", "limit": 5000}).json()["bars"]
    assert len(bars) == 1 and bars[0]["c"] == 2500.5
    assert client.get("/prices/summary").json()["source"] == "dukascopy"


def test_ticks_to_second_and_minute_bars():
    hour = datetime(2024, 1, 2, 10, tzinfo=UTC)
    raw = ingest._TICK.pack(100, 0, 2050000, 0, 1.0) + ingest._TICK.pack(900, 0, 2051000, 0, 1.0)
    raw += ingest._TICK.pack(61_500, 0, 2049000, 0, 2.0)
    secs = ingest.parse_ticks_to_bars(raw, hour, 1)
    assert [(b.ts - hour).seconds for b in secs] == [0, 61]
    assert (secs[0].open, secs[0].high, secs[0].close, secs[0].volume) == (2050.0, 2051.0, 2051.0, 2.0)
    mins = ingest.parse_ticks_to_bars(raw, hour, 60)
    assert [(b.ts - hour).seconds for b in mins] == [0, 60]


def test_all_timeframes(client, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "MINUTE_DAYS", 2)
    monkeypatch.setattr(config, "SECOND_DAYS", 1)
    ingest.backfill("sample", date.today() - timedelta(days=120))
    tfs = ["1s", "5s", "15s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1mo"]
    size = {"1s": 1, "5s": 5, "15s": 15, "30s": 30, "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
            "1h": 3600, "4h": 14400}
    for tf in tfs:
        bars = client.get("/prices/candles", params={"tf": tf, "limit": 50}).json()["bars"]
        assert bars, tf
        ts = [b["t"] for b in bars]
        assert ts == sorted(set(ts)), tf
        assert all(b["l"] <= min(b["o"], b["c"]) + 1e-9 and b["h"] + 1e-9 >= max(b["o"], b["c"]) for b in bars), tf
        if tf in size:
            assert all(t % size[tf] == 0 for t in ts), tf
    # A 5-minute bar matches the five minutes inside it.
    five = client.get("/prices/candles", params={"tf": "5m", "limit": 3}).json()["bars"][0]
    mins = client.get("/prices/candles", params={"tf": "1m", "start": five["t"], "end": five["t"] + 300}).json()["bars"]
    assert five["o"] == mins[0]["o"] and five["c"] == mins[-1]["c"]
    assert five["h"] == max(m["h"] for m in mins) and five["l"] == min(m["l"] for m in mins)
    # Weeks start on Monday, months on the 1st.
    weeks = client.get("/prices/candles", params={"tf": "1w", "limit": 5}).json()["bars"]
    assert all(datetime.fromtimestamp(w["t"], UTC).weekday() == 0 for w in weeks)
    months = client.get("/prices/candles", params={"tf": "1mo", "limit": 3}).json()["bars"]
    assert all(datetime.fromtimestamp(m["t"], UTC).day == 1 for m in months)
    # Paging back from the oldest bar returns earlier bars only.
    first = client.get("/prices/candles", params={"tf": "15m", "limit": 20}).json()["bars"]
    older = client.get("/prices/candles", params={"tf": "15m", "end": first[0]["t"], "limit": 20}).json()["bars"]
    assert older and older[-1]["t"] < first[0]["t"]
    # Minute and second history is trimmed to its window.
    oldest = client.get("/prices/candles", params={"tf": "1s", "start": 0, "limit": 1}).json()["bars"][0]
    assert oldest["t"] >= (datetime.now(UTC) - timedelta(days=1, minutes=1)).timestamp()
