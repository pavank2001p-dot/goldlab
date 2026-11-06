from datetime import date, datetime, timedelta, timezone

from app import assistant, config, db, ingest


def test_monthly_history_file():
    bars = ingest.monthly_history()
    assert bars[0].ts == datetime(1833, 1, 1, tzinfo=timezone.utc) and bars[0].close == 18.93
    assert len({b.ts for b in bars}) == len(bars)
    assert all(a.ts < b.ts for a, b in zip(bars, bars[1:]))
    # Each bar opens at the previous month's price and spans it.
    assert all(b.open == a.close and b.low <= min(b.open, b.close) and b.high >= max(b.open, b.close)
               for a, b in zip(bars, bars[1:]))
    # A few well-known levels: the $35 peg, the 1980 spike.
    by_month = {b.ts.strftime("%Y-%m"): b.close for b in bars}
    assert by_month["1959-12"] == 35.1 and by_month["1980-01"] > 600


def test_monthly_chart_reaches_1833(client):
    ingest.backfill("sample", date.today() - timedelta(days=90))
    assert ingest.load_monthly_history() > 2000
    first_daily = client.get("/prices/candles", params={"tf": "1d", "start": 0, "limit": 1}).json()["bars"][0]["t"]

    # Latest months come from the daily bars; older ones from the history, with no overlap.
    latest = client.get("/prices/candles", params={"tf": "1mo", "limit": 12}).json()["bars"]
    ts = [b["t"] for b in latest]
    assert ts == sorted(set(ts)) and len(ts) == 12

    oldest = client.get("/prices/candles", params={"tf": "1mo", "start": -5_000_000_000, "limit": 3}).json()["bars"]
    assert datetime.fromtimestamp(oldest[0]["t"], timezone.utc).year == 1833

    everything = client.get("/prices/candles", params={"tf": "1mo", "start": -5_000_000_000, "limit": 5000}).json()["bars"]
    months = [datetime.fromtimestamp(b["t"], timezone.utc).strftime("%Y-%m") for b in everything]
    assert len(months) == len(set(months)) and months == sorted(months)
    first_daily_month = datetime.fromtimestamp(first_daily, timezone.utc).strftime("%Y-%m")
    assert first_daily_month in months

    # Paging back from a date works across the join.
    end = int(datetime(1971, 9, 1, tzinfo=timezone.utc).timestamp())
    page = client.get("/prices/candles", params={"tf": "1mo", "end": end, "limit": 2}).json()["bars"]
    assert [datetime.fromtimestamp(b["t"], timezone.utc).strftime("%Y-%m") for b in page] == ["1971-07", "1971-08"]

    # Daily and hourly views are unchanged by the monthly history.
    assert client.get("/prices/candles", params={"tf": "1d", "start": 0, "limit": 1}).json()["bars"][0]["t"] == first_daily
    assert client.get("/prices/summary").json()["first_month"] == int(datetime(1833, 1, 1, tzinfo=timezone.utc).timestamp())


def test_switching_source_keeps_history(client):
    ingest.load_monthly_history()
    ingest.backfill("sample", date.today() - timedelta(days=10))
    db.set_meta("price_source", "dukascopy")  # pretend real data was loaded before
    ingest.load("sample", datetime.now(timezone.utc) - timedelta(days=2), datetime.now(timezone.utc))
    with db.conn() as c:
        n = c.execute("SELECT count(*) AS n FROM candles WHERE tf = '1mo'").fetchone()["n"]
    assert n == len(ingest.monthly_history())


def test_extend_history_runs_once(client, monkeypatch):
    calls = []
    monkeypatch.setattr(config, "HISTORY_SINCE", date(2003, 5, 1))
    monkeypatch.setattr(ingest, "load", lambda source, start, end: calls.append((start, end)) or 7)
    ingest.upsert([ingest.Bar(datetime(2010, 1, 4, tzinfo=timezone.utc), 1, 1, 1, 1)])
    assert ingest.extend_history("sample") == 0 and not calls  # never for demo data
    assert ingest.extend_history("dukascopy") == 7
    assert calls == [(datetime(2003, 5, 1, tzinfo=timezone.utc), datetime(2010, 1, 4, tzinfo=timezone.utc))]
    assert ingest.extend_history("dukascopy") == 0 and len(calls) == 1  # remembered


def test_assistant_uses_monthly_prices_before_daily_data(client):
    ingest.load_monthly_history()
    ingest.backfill("sample", date.today() - timedelta(days=30))
    out = assistant.t_price_history({"start": "1970-01-01", "end": "1981-01-01"}, 0)
    assert out["first_month"] == "1970-01" and out["last_month"] == "1980-12"
    assert out["high"] > 600 and "monthly" in out["resolution"]
    recent = assistant.t_price_history({"start": (date.today() - timedelta(days=20)).isoformat()}, 0)
    assert "trading_days" in recent
