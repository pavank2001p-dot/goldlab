from datetime import datetime, timedelta, timezone

import pytest

from app import db, practice
from app.live import feed
from app.practice import ReplayTrade, insights, score, settle


def signup(client, email="r@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def put(ts: datetime, o, h, l, c, tf="1m"):
    with db.conn() as conn:
        conn.execute(
            "INSERT INTO candles (symbol, tf, ts, open, high, low, close) VALUES ('XAUUSD', %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT DO NOTHING",
            (tf, ts, o, h, l, c))


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


B = [{"o": 100, "h": 101, "l": 99, "c": 100}, {"o": 100, "h": 103, "l": 99.5, "c": 102},
     {"o": 102, "h": 102.5, "l": 97, "c": 98}, {"o": 98, "h": 99, "l": 96, "c": 97}]


def test_settle_stops_targets_and_closes():
    assert settle(B, ReplayTrade(side="long", units=10, entry_bar=0, exit_bar=1))["pnl"] == 20
    s = settle(B, ReplayTrade(side="long", units=10, entry_bar=0, exit_bar=3, stop=98, target=105))
    assert s["reason"] == "stop" and s["exit_bar"] == 2 and s["pnl"] == -20
    s = settle(B, ReplayTrade(side="short", units=1, entry_bar=1, exit_bar=3, stop=104, target=98.5))
    assert s["reason"] == "target" and s["exit_price"] == 98.5


def test_score_enforces_challenge_rules():
    ok = score(B, [ReplayTrade(side="short", units=50, entry_bar=1, exit_bar=3, stop=105)], require_stop=True)
    assert ok["return_pct"] == 2.5 and ok["trades"] == 1 and ok["wins"] == 1
    with pytest.raises(Exception, match="no stop"):
        score(B, [ReplayTrade(side="long", units=1, entry_bar=0, exit_bar=1)], require_stop=True)
    with pytest.raises(Exception, match="risks more"):
        score(B, [ReplayTrade(side="long", units=100, entry_bar=0, exit_bar=1, stop=97)], require_stop=True)
    with pytest.raises(Exception, match="before the previous"):
        score(B, [ReplayTrade(side="long", units=1, entry_bar=0, exit_bar=2),
                  ReplayTrade(side="long", units=1, entry_bar=1, exit_bar=3)], require_stop=False)
    with pytest.raises(Exception, match="leverage"):
        score(B, [ReplayTrade(side="long", units=5000, entry_bar=0, exit_bar=1)], require_stop=False)


def test_insights_spot_quick_trades_after_losses():
    t0 = datetime(2026, 10, 5, 9, tzinfo=timezone.utc)
    trades = []
    for k in range(8):
        o = t0 + timedelta(minutes=20 * k)
        trades.append({"side": "long", "units": 1 if k % 2 == 0 else 3, "open": o, "close": o + timedelta(minutes=10),
                       "stop": None, "pnl": -50 if k % 2 == 0 else -10})
    r = insights(trades)
    keys = [i["key"] for i in r["items"]]
    assert "revenge" in keys and "sizing" in keys and "stops" in keys
    assert r["items"][0]["tone"] == "warn"
    assert insights(trades[:3])["items"] == []


def test_alerts_trigger_once(client):
    signup(client)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    put(now - timedelta(minutes=2), 2000, 2001, 1999, 2000)
    up = client.post("/practice/alerts", json={"price": 2010, "note": "breakout"}).json()
    down = client.post("/practice/alerts", json={"price": 1990}).json()
    assert up["direction"] == "above" and down["direction"] == "below"
    assert client.post("/practice/alerts/check").json()["triggered"] == []
    put(now, 2000, 2012, 2000, 2005)
    hit = client.post("/practice/alerts/check").json()["triggered"]
    assert [a["id"] for a in hit] == [up["id"]]
    assert client.post("/practice/alerts/check").json()["triggered"] == []
    client.delete(f"/practice/alerts/{down['id']}")
    assert len(client.get("/practice/alerts").json()) == 1


def test_challenge_one_go_and_opt_in_board(client, monkeypatch):
    # A weekday 10 days back with minute bars across the session.
    day = practice._weekday((datetime.now(timezone.utc) - timedelta(days=10)).date())
    monkeypatch.setattr(practice, "_weekday", lambda d: day)
    start = datetime(day.year, day.month, day.day, 6, tzinfo=timezone.utc)
    for m in range(0, 15 * 60):
        p = 2000 + m * 0.01
        put(start + timedelta(minutes=m), p, p + 0.5, p - 0.5, p)
    signup(client)
    ch = client.get("/practice/challenge").json()
    assert ch["tf"] == "5m" and len(ch["bars"]) == 180 and ch["board"]["players"] == 0
    bars = ch["bars"]
    entry = bars[10]["c"]
    trade = {"side": "long", "units": 90, "entry_bar": 10, "exit_bar": 100, "stop": entry - 1.5}
    assert client.post("/practice/challenge", json={"trades": [trade], "public": True}).status_code == 422  # no nickname
    r = client.post("/practice/challenge", json={"trades": [trade], "public": False})
    assert r.status_code == 201, r.text
    res = r.json()
    assert res["return_pct"] > 0 and res["board"]["players"] == 1 and res["board"]["top"] == []
    assert client.post("/practice/challenge", json={"trades": [trade]}).status_code == 409
    board = client.patch("/practice/challenge", json={"public": True, "nickname": "Goldie"}).json()
    assert board["top"][0]["nickname"] == "Goldie" and board["top"][0]["me"]
    again = client.get("/practice/challenge").json()
    assert again["bars"] == [] and again["board"]["mine"]["rank"] == 1 and again["nickname"] == "Goldie"
