from datetime import date, datetime, timedelta, timezone

import pytest

from app import achievements, db, risk
from app.live import feed

from .test_paper import bar, signup


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def test_streaks_count_runs_and_forgive_an_empty_today():
    today = date(2026, 11, 6)
    days = {today - timedelta(days=i) for i in (1, 2, 3)} | {date(2026, 10, 1), date(2026, 10, 2)}
    assert achievements.streaks(days, today) == (3, 3)
    assert achievements.streaks(days | {today}, today) == (4, 4)
    assert achievements.streaks({today - timedelta(days=3)}, today) == (0, 1)
    assert achievements.streaks(set(), today) == (0, 0)


def by_key(client):
    r = client.get("/achievements")
    assert r.status_code == 200, r.text
    return r.json(), {b["key"]: b for b in r.json()["badges"]}


def test_badges_follow_habits(client):
    assert client.get("/achievements").status_code == 401
    signup(client, "a@example.com")
    data, b = by_key(client)
    assert data["earned"] == 0 and data["streak"]["current"] == 0

    answers = {q["key"]: 1 for q in risk.QUESTIONS}
    assert client.post("/risk/profile", json={"answers": answers}).json()["max_risk_per_trade_pct"] == 0.5
    bar(-2, 2000, 2001, 1999, 2000)
    # 10 oz with a $4.30 stop (from the 2000.30 ask) risks $43, inside 0.5% of $10,000; the trade without a stop breaks both runs.
    client.post("/paper/orders", json={"side": "long", "units": 1})
    for _ in range(3):
        assert client.post("/paper/orders", json={"side": "long", "units": 10, "stop_loss": 1996}).status_code == 201
    _, b = by_key(client)
    assert b["limits"]["earned"]
    assert b["stops"]["progress"] == 3 and not b["stops"]["earned"]
    assert b["inside"]["progress"] == 3
    # Risking $300 on one trade is over the limit, so the run restarts.
    client.post("/paper/orders", json={"side": "long", "units": 10, "stop_loss": 1970})
    _, b = by_key(client)
    assert b["stops"]["progress"] == 4 and b["inside"]["progress"] == 0
    assert b["pace"]["earned"]  # five trades, all on one day, no more than five

    now = datetime.now(timezone.utc)
    for i in range(3):
        r = client.post("/trades", json={"side": "long", "units": 1, "open_time": (now - timedelta(days=i)).isoformat(),
                                         "open_price": 2000, "notes": "Waited for my level" if i else ""})
        assert r.status_code == 201, r.text
    with db.conn() as c:  # entries made on the last three days
        c.execute("UPDATE trades SET created_at = now() - (id - 1) * interval '1 day'")
    data, b = by_key(client)
    assert data["streak"] == {"current": 3, "best": 3, "logged_today": True}
    assert b["notes"]["progress"] == 2 and b["streak"]["progress"] == 3
