import json
from datetime import datetime, timezone

from app import ingest, live

UTC = timezone.utc
T = datetime(2026, 1, 5, 19, 30, 10, tzinfo=UTC).timestamp()


def test_ticks_build_bars_and_flush(client):
    f = live.Live()
    f.tick(2000.0, T)
    f.tick(2003.0, T + 0.5)
    f.tick(1999.0, T + 1.2)
    f.tick(2001.0, T + 61)
    f.tick(1900.0, T - 30)  # stale quote ignored
    assert f.price == 2001.0
    secs = f.bars["1s"]
    first = secs[int(T)]
    assert (first.open, first.high, first.low, first.close) == (2000.0, 2003.0, 2000.0, 2003.0)
    assert len(secs) == 3 and len(f.bars["1m"]) == 2 and len(f.bars["1h"]) == 1
    minute = f.bars["1m"][int(T) // 60 * 60]
    assert (minute.open, minute.high, minute.low, minute.close) == (2000.0, 2003.0, 1999.0, 1999.0)

    assert f.flush() == 6
    assert all(len(b) == 1 for b in f.bars.values())  # only the bars still in progress stay
    bars = client.get("/prices/candles", params={"tf": "1s", "start": int(T), "limit": 10}).json()["bars"]
    assert [b["c"] for b in bars] == [2003.0, 1999.0, 2001.0]


def test_handle_finnhub_message(monkeypatch):
    f = live.Live()
    monkeypatch.setattr(live, "feed", f)
    live.handle(json.dumps({"type": "ping"}))
    live.handle(json.dumps({"type": "trade", "data": [
        {"s": "OANDA:XAU_USD", "p": 2650.25, "t": int(T * 1000), "v": 0},
        {"s": "OANDA:EUR_USD", "p": 1.08, "t": int(T * 1000), "v": 0},
    ]}))
    assert f.price == 2650.25 and f.t == T


def test_live_endpoint(client, monkeypatch):
    f = live.Live()
    monkeypatch.setattr(live, "feed", f)
    assert client.get("/prices/live").json()["price"] is None
    t = datetime.now(UTC).timestamp() - 10
    f.tick(2650.0, t)
    body = client.get("/prices/live").json()
    assert body["price"] == 2650.0 and body["t"] == t and 9 < body["age_seconds"] < 60


def test_historical_progress_ignores_live_bars(client, monkeypatch):
    """Live bars for recent minutes must not stop the historical feed fetching earlier hours."""
    calls = []
    monkeypatch.setattr(ingest, "dukascopy_hourly", lambda s, e, i=None: iter([]))
    monkeypatch.setattr(ingest, "dukascopy_minutes", lambda s, e, i=None: calls.append(("1m", s)) or iter([]))
    monkeypatch.setattr(ingest, "dukascopy_seconds", lambda s, e, i=None: calls.append(("1s", s)) or iter([]))
    f = live.Live()
    f.tick(2650.0, datetime.now(UTC).timestamp())
    f.flush()
    ingest.load_fine("dukascopy")
    starts = dict(calls)
    assert (datetime.now(UTC) - starts["1m"]).days >= 1  # from the retention floor, not the live bar
    calls.clear()
    ingest.load_fine("dukascopy")
    second = dict(calls)
    assert (datetime.now(UTC) - second["1m"]).total_seconds() < 2 * 3600 + 60


def test_other_markets_keep_fewer_minute_bars(client, monkeypatch):
    """Gold keeps MINUTE_DAYS of minute bars; other markets keep MARKET_MINUTE_DAYS, which keeps the database small."""
    from app import config, instruments

    starts = {}
    monkeypatch.setattr(config, "MINUTE_DAYS", 60)
    monkeypatch.setattr(config, "MARKET_MINUTE_DAYS", 14)
    monkeypatch.setattr(ingest, "dukascopy_minutes", lambda s, e, i=None: starts.setdefault(i.symbol, s) and iter([]))
    monkeypatch.setattr(ingest, "dukascopy_seconds", lambda s, e, i=None: iter([]))
    other = next(i for i in instruments.ENABLED if i.symbol != ingest.GOLD.symbol)
    ingest.load_fine("dukascopy", ingest.GOLD)
    ingest.load_fine("dukascopy", other)
    assert 59 <= (datetime.now(UTC) - starts[ingest.GOLD.symbol]).days <= 60
    assert 13 <= (datetime.now(UTC) - starts[other.symbol]).days <= 14
