"""Daily Candle: the hidden moment, one answer a day, the verdict, streaks and the crowd split."""

import random
from datetime import date, datetime, timedelta, timezone

from app import daily, db
from tests.test_paper import signup


def seed_hours(days: int = 90, end_days_ago: int = 35):
    """Weekday hourly gold bars, a seeded random walk, ending a while ago so the picker can use them."""
    rnd = random.Random(3)
    end = (datetime.now(timezone.utc) - timedelta(days=end_days_ago)).replace(minute=0, second=0, microsecond=0)
    t = end - timedelta(days=days)
    p = 2000.0
    rows = []
    while t < end:
        if t.weekday() < 5:
            o = p
            p = max(100.0, p + rnd.gauss(0, 4))
            rows.append(("XAUUSD", "1h", t, o, max(o, p) + rnd.random() * 2, min(o, p) - rnd.random() * 2, p))
        t += timedelta(hours=1)
    with db.conn() as c:
        with c.cursor() as cur:
            cur.executemany("INSERT INTO candles (symbol, tf, ts, open, high, low, close) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                            rows)


def test_verdict_and_outcome():
    future = [{"o": 100, "h": 101, "l": 99.5, "c": 100.5}, {"o": 100.5, "h": 102, "l": 100, "c": 101.5}]
    v = daily.verdict(100.0, future)
    assert v["best"] == "buy" and v["move_pct"] == 1.5 and v["low_pct"] == -0.5
    assert daily.outcome("buy", v) == {"right": True, "pnl_1000": 15.0, "against_pct": 0.5}
    assert daily.outcome("sell", v) == {"right": False, "pnl_1000": -15.0, "against_pct": 2.0}
    assert daily.outcome("wait", v)["pnl_1000"] == 0.0
    flat = daily.verdict(100.0, [{"o": 100, "h": 100.3, "l": 99.8, "c": 100.1}])
    assert flat["best"] == "wait" and daily.outcome("wait", flat)["right"]


def test_streak_counts_days_in_a_row():
    now = date(2026, 11, 12)
    assert daily.streak([now, now - timedelta(days=1), now - timedelta(days=2), now - timedelta(days=4)], now) == 3
    assert daily.streak([now - timedelta(days=1), now - timedelta(days=2)], now) == 2   # today not played yet
    assert daily.streak([now - timedelta(days=3)], now) == 0


def test_moment_hides_the_date_and_level(client):
    seed_hours()
    r = client.get("/daily")
    assert r.status_code == 200
    d = r.json()
    assert len(d["bars"]) == daily.CONTEXT and d["bars"][-1]["c"] == 100
    assert "t" not in d["bars"][0] and d["played"] is None
    # Chosen once and kept: the same moment on a second load.
    with db.conn() as c:
        first = c.execute("SELECT frozen_ts FROM daily_candles").fetchone()["frozen_ts"]
    assert client.get("/daily").json()["bars"] == d["bars"]
    assert datetime.fromtimestamp(first, tz=timezone.utc).weekday() < 5


def test_signed_out_play_is_answered_not_kept(client):
    seed_hours()
    r = client.post("/daily", json={"choice": "sell"}).json()
    assert r["choice"] == "sell" and len(r["future"]) == daily.HORIZON and r["you"] is None
    assert r["crowd"]["total"] == 0
    assert r["best"] in ("buy", "sell", "wait") and r["price"] > 0


def test_signed_in_first_answer_counts(client):
    seed_hours()
    signup(client)
    first = client.post("/daily", json={"choice": "buy"}).json()
    again = client.post("/daily", json={"choice": "sell"}).json()
    assert again["choice"] == "buy" and again["move_pct"] == first["move_pct"]
    assert again["crowd"] == {"buy": 1, "sell": 0, "wait": 0, "total": 1}
    assert again["you"]["streak"] == 1 and again["you"]["played"] == 1
    g = client.get("/daily").json()
    assert g["played"]["choice"] == "buy"


def test_no_history_is_a_clear_error(client):
    assert client.get("/daily").status_code == 503
