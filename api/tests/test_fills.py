"""Realistic fills: wider spreads and slipping stops around big releases and at the daily rollover."""

from datetime import date, datetime, timedelta, timezone

import pytest

from app import backtest, db, fills
from app import instruments as ins
from app.live import feed
from tests.test_paper import bar, signup

REAL_IN_ROLLOVER = fills.in_rollover  # the conftest fixture replaces it during each test


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def event(minutes_from_now: float, title="CPI m/m"):
    ts = datetime.now(timezone.utc) + timedelta(minutes=minutes_from_now)
    with db.conn() as c:
        c.execute("INSERT INTO events (ts, title, impact, source) VALUES (%s, %s, 'High', 't')", (ts, title))
    fills.clear_cache()


def test_conditions():
    g = ins.GOLD
    e = datetime(2026, 3, 11, 12, 30, tzinfo=timezone.utc)
    c = fills.Conditions([e])
    assert c.spread(g, e - timedelta(minutes=6)) == g.spread
    assert c.spread(g, e + timedelta(minutes=10)) == g.spread * fills.NEWS_SPREAD_X
    assert c.slip(g, e) == g.spread and c.why(g, e) == "news"
    assert fills.Conditions([e], on=False).spread(g, e) == g.spread


def test_rollover_clock(monkeypatch):
    monkeypatch.setattr(fills, "in_rollover", REAL_IN_ROLLOVER)
    g, btc = ins.GOLD, ins.get("BTCUSD")
    roll = datetime(2026, 3, 11, 21, 5, tzinfo=timezone.utc)  # 17:05 New York, daylight time
    assert fills.in_rollover(roll) and not fills.in_rollover(roll + timedelta(minutes=15))
    assert fills.in_rollover(datetime(2026, 1, 14, 22, 0, tzinfo=timezone.utc))  # 17:00 in winter time
    c = fills.Conditions([])
    assert c.spread(g, roll) == g.spread * fills.ROLLOVER_SPREAD_X and c.spread(btc, roll) == btc.spread


def test_paper_spread_widens_and_stop_slips_on_news(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    s = client.get("/paper").json()
    assert s["price"]["ask"] == 2000.3 and s["settings"]["wide"] is None and s["settings"]["realistic_fills"]
    pid = client.post("/paper/orders", json={"side": "long", "units": 1, "stop_loss": 1990}).json()["position"]["id"]

    event(0.5)  # a release right now
    s = client.get("/paper").json()
    assert s["price"]["ask"] == 2001.2 and s["settings"]["wide"] == "news" and s["settings"]["spread_now"] == 1.2
    bar(1, 1995, 1996, 1985, 1987)  # through the 1990 stop during the release: fills 0.30 lower
    h = client.get("/paper").json()["history"][0]
    assert h["id"] == pid and h["close_reason"] == "stop_loss" and h["exit_price"] == 1989.7


def test_paper_realistic_fills_can_be_turned_off(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    event(0.5)
    s = client.patch("/paper/settings", json={"realistic_fills": False}).json()
    assert s["settings"]["realistic_fills"] is False and s["price"]["ask"] == 2000.3
    assert s["account"]["leverage"] == 20  # leverage untouched
    client.post("/paper/orders", json={"side": "long", "units": 1, "stop_loss": 1990})
    bar(1, 1995, 1996, 1985, 1987)
    assert client.get("/paper").json()["history"][0]["exit_price"] == 1990


def test_backtest_realistic_fills_cost_more_around_news():
    t0 = int(datetime(2026, 3, 9, tzinfo=timezone.utc).timestamp())
    bars = []
    for i in range(300):  # a steady zig-zag so a short MA cross trades often
        px = 2000 + (10 if (i // 5) % 2 else -10) + i * 0.01
        bars.append({"t": t0 + i * 3600, "o": px, "h": px + 3, "l": px - 3, "c": px})
    cfg = backtest.BacktestIn(strategy="ma_cross", params={"fast": 3, "slow": 6}, tf="1h", start=date(2026, 3, 9),
                              stop_loss_pct=0.2)
    plain = backtest.run(cfg, bars)
    events = [datetime.fromtimestamp(b["t"], timezone.utc) + timedelta(minutes=10) for b in bars[::3]]
    real = backtest.run(cfg, bars, fills.Conditions(events))
    assert real["stats"]["slipped_stops"] > 0
    assert real["stats"]["net_profit"] < plain["stats"]["net_profit"]
    assert "slipped_stops" not in plain["stats"]
