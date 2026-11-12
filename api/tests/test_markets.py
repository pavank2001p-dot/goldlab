from datetime import date, datetime, timedelta, timezone

import pytest

from app import backtest, db, ingest, instruments, paper
from app.live import feed, feed_of

UTC = timezone.utc
BTC = instruments.get("BTCUSD")
EUR = instruments.get("EURUSD")
AAPL = instruments.get("AAPLUSUSD")


def signup(client, email="m@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def bar(symbol: str, minutes_from_now: float, o, h, l, c, tf="1m"):
    ts = (datetime.now(UTC) + timedelta(minutes=minutes_from_now)).replace(second=0, microsecond=0)
    with db.conn() as conn:
        conn.execute(
            """INSERT INTO candles (symbol, tf, ts, open, high, low, close) VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (symbol, tf, ts) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high,
               low = EXCLUDED.low, close = EXCLUDED.close""",
            (symbol, tf, ts, o, h, l, c))


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    for f in (feed, feed_of("BTCUSD"), feed_of("EURUSD")):
        monkeypatch.setattr(f, "price", None)
        monkeypatch.setattr(f, "t", None)


def test_registry_and_feed_scale():
    assert instruments.get(None) is instruments.GOLD and instruments.get("btcusd") is BTC
    with pytest.raises(KeyError):
        instruments.get("NOPE")
    # Raw integers from the feed are matched to the market's rough price by a power of ten.
    assert instruments.fit_point(108_512, 1.1) == 100_000
    assert instruments.fit_point(229_450, 230) == 1000
    assert instruments.fit_point(912_345, 90_000) == 10
    assert all(i.symbol == i.symbol.upper() for i in instruments.ALL)


def test_trading_hours_by_class():
    wed_noon_ny = datetime(2026, 11, 11, 17, tzinfo=UTC)
    wed_evening_ny = datetime(2026, 11, 11, 23, tzinfo=UTC)
    saturday = datetime(2026, 11, 14, 15, tzinfo=UTC)
    assert AAPL.is_open(wed_noon_ny) and not AAPL.is_open(wed_evening_ny) and not AAPL.is_open(saturday)
    assert EUR.is_open(wed_evening_ny) and not EUR.is_open(saturday)
    assert BTC.is_open(saturday)


def test_sample_markets_load_and_chart(client):
    ingest.backfill("sample", date.today() - timedelta(days=20), EUR)
    ingest.backfill("sample", date.today() - timedelta(days=20), BTC)
    m = {x["symbol"]: x for x in client.get("/prices/markets").json()["markets"]}
    assert m["EURUSD"]["price"] and 0.5 < m["EURUSD"]["price"] < 2
    assert m["BTCUSD"]["price"] > 10_000 and m["XAUUSD"]["price"] is None
    assert m["BTCUSD"]["max_leverage"] == 10 and m["AAPLUSUSD"]["class_label"] == "US stocks"

    eur = client.get("/prices/candles", params={"symbol": "EURUSD", "tf": "1d", "limit": 50}).json()
    assert eur["symbol"] == "EURUSD" and eur["bars"] and eur["bars"][-1]["c"] < 2
    btc = client.get("/prices/candles", params={"symbol": "BTCUSD", "tf": "1h", "limit": 500}).json()["bars"]
    # Crypto trades at weekends, so its sample data has weekend hours; forex doesn't.
    assert any(datetime.fromtimestamp(b["t"], UTC).weekday() == 5 for b in btc)
    eur_h = client.get("/prices/candles", params={"symbol": "EURUSD", "tf": "1h", "limit": 500}).json()["bars"]
    assert not any(datetime.fromtimestamp(b["t"], UTC).weekday() == 5 for b in eur_h)
    assert client.get("/prices/candles", params={"symbol": "NOPE"}).status_code == 404
    s = client.get("/prices/summary", params={"symbol": "BTCUSD"}).json()
    assert s["name"] == "Bitcoin" and s["source"] == "sample"
    assert client.get("/prices/summary").json()["price"] is None  # gold untouched


def test_backtest_uses_the_markets_costs(client):
    ingest.load("sample", datetime(2024, 1, 1, tzinfo=UTC), datetime(2025, 1, 1, tzinfo=UTC), EUR)
    cfg = backtest.BacktestIn(strategy="ma_cross", symbol="EURUSD", start=date(2024, 1, 1), end=date(2025, 1, 1))
    assert cfg.spread == EUR.spread and cfg.units == EUR.default_units
    rep = backtest.run(cfg, backtest.load_bars("1d", cfg.start, cfg.end, "EURUSD"))
    assert rep["stats"]["trades"] > 0
    t = rep["trades"][0]
    assert t["costs"] == round(EUR.spread * EUR.default_units, 2)
    signup(client)
    r = client.post("/backtests", json={"strategy": "ma_cross", "symbol": "EURUSD", "start": "2024-01-01", "end": "2025-01-01"})
    assert r.status_code == 201 and r.json()["params"]["symbol"] == "EURUSD"
    assert client.post("/backtests", json={"strategy": "ma_cross", "symbol": "NOPE"}).status_code == 422


def test_paper_trades_another_market_with_its_leverage_cap(client):
    signup(client)
    bar("BTCUSD", -2, 90_000, 90_100, 89_900, 90_000)
    bar("XAUUSD", -2, 2000, 2001, 1999, 2000)
    s = client.get("/paper", params={"symbol": "BTCUSD"}).json()
    assert s["symbol"] == "BTCUSD" and s["price"]["bid"] == 90_000 and s["price"]["ask"] == 90_000 + BTC.spread
    assert s["settings"]["market_leverage"] == 10  # the account's 1:20 is capped at 1:10 for crypto

    # 1 BTC needs $9,000 of margin at 1:10; 2 BTC would need $18,000, more than the $10,000 account.
    r = client.post("/paper/orders", json={"symbol": "BTCUSD", "side": "long", "units": 2})
    assert r.status_code == 422 and "capped at 1:10" in r.json()["detail"]
    r = client.post("/paper/orders", json={"symbol": "BTCUSD", "side": "long", "units": 1, "stop_loss": 88_000})
    assert r.status_code == 201 and r.json()["position"]["symbol"] == "BTCUSD"
    # A gold position alongside it, at gold's own spread and 1:20.
    g = client.post("/paper/orders", json={"side": "short", "units": 1}).json()["position"]
    assert g["symbol"] == "XAUUSD" and g["entry_price"] == 2000

    s = client.get("/paper").json()
    assert {p["symbol"] for p in s["positions"]} == {"BTCUSD", "XAUUSD"}
    assert s["account"]["margin_used"] == pytest.approx(90_000 * 0.1 + 2000 * 0.05)

    # BTC falls through the stop; gold doesn't move. Only the BTC position closes.
    bar("BTCUSD", 1, 89_000, 89_000, 87_500, 87_600)
    s = client.get("/paper").json()
    assert [p["symbol"] for p in s["positions"]] == ["XAUUSD"]
    closed = s["history"][0]
    assert closed["symbol"] == "BTCUSD" and closed["close_reason"] == "stop_loss" and closed["exit_price"] == 88_000
    assert closed["pnl"] == pytest.approx(88_000 - 90_030, abs=0.01)
    rep = client.get("/paper/report").json()
    assert rep["trades"][0]["costs"] == BTC.spread


def test_forex_prices_keep_their_decimals(client):
    signup(client)
    bar("EURUSD", -2, 1.08512, 1.0852, 1.085, 1.08512)
    s = client.get("/paper", params={"symbol": "EURUSD"}).json()
    assert s["price"]["bid"] == 1.08512 and s["price"]["ask"] == 1.08522
    r = client.post("/paper/orders", json={"symbol": "EURUSD", "side": "long", "kind": "limit", "units": 10_000,
                                           "price": 1.08, "stop_loss": 1.07})
    assert r.status_code == 201 and r.json()["order"]["symbol"] == "EURUSD"
    r = client.post("/paper/orders", json={"symbol": "EURUSD", "side": "long", "kind": "limit", "units": 10_000,
                                           "price": 1.09})
    assert r.status_code == 422 and "1.08522" in r.json()["detail"]
