"""Manual backtesting sessions: any range, a higher timeframe beside it, blind mode, save and resume, finish."""

from datetime import datetime, timedelta, timezone

from app import db


def signup(client, email="s@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def hours(start: datetime, n: int, tf="1h", step=3600, base=2000.0):
    with db.conn() as c:
        for i in range(n):
            px = base + (i % 10)
            c.execute("INSERT INTO candles (symbol, tf, ts, open, high, low, close) VALUES ('XAUUSD', %s, %s, %s, %s, %s, %s)",
                      (tf, start + timedelta(seconds=i * step), px, px + 2, px - 2, px + 1))


T0 = datetime(2025, 3, 3, tzinfo=timezone.utc)  # a Monday


def test_session_lifecycle(client):
    signup(client)
    hours(T0 - timedelta(days=10), 24 * 40)
    hours(T0 - timedelta(days=60), 70, tf="1d", step=86400)
    r = client.post("/practice/sessions", json={"tf": "1h", "start": "2025-03-03", "end": "2025-03-17", "name": "March"})
    assert r.status_code == 201, r.json()
    s = r.json()
    assert len(s["bars"]) == 24 * 14 and s["bars"][0]["t"] == int(T0.timestamp())
    assert len(s["context"]) == 48 and s["htf"]["tf"] == "1d" and s["htf"]["seconds"] == 86400
    assert s["htf"]["context"] and s["htf"]["context"][-1]["t"] < int(T0.timestamp())
    assert s["start"] == "2025-03-03" and s["state"] == {} and not s["finished"]

    state = {"k": 50, "done": [{"side": "long", "units": 1, "entry_bar": 3, "exit_bar": 9}], "pos": None}
    assert client.put(f"/practice/sessions/{s['id']}", json={"state": state}).status_code == 200
    again = client.get(f"/practice/sessions/{s['id']}").json()
    assert again["state"]["k"] == 50 and again["progress"] == {"shown": 50, "trades": 1}
    assert client.get("/practice/sessions").json()[0]["progress"]["shown"] == 50

    fin = client.post(f"/practice/sessions/{s['id']}/finish", json={"trades": [
        {"side": "long", "units": 10, "entry_bar": 3, "exit_bar": 9, "stop": None, "target": None}]}).json()
    assert fin["finished"] and fin["result"]["trades"] == 1
    assert client.put(f"/practice/sessions/{s['id']}", json={"state": state}).status_code == 409
    assert client.delete(f"/practice/sessions/{s['id']}").status_code == 204
    assert client.get("/practice/sessions").json() == []


def test_blind_hides_dates_until_finished(client):
    signup(client)
    hours(T0 - timedelta(days=10), 24 * 120)
    s = client.post("/practice/sessions", json={"tf": "1h", "blind": True}).json()  # a random stretch
    assert s["blind"] and s["start"] is None and s["end"] is None and len(s["bars"]) >= 20
    listed = client.get("/practice/sessions").json()[0]
    assert listed["start"] is None
    fin = client.post(f"/practice/sessions/{s['id']}/finish", json={"trades": []}).json()
    assert fin["start"] is not None
    assert client.get("/practice/sessions").json()[0]["start"] == fin["start"]


def test_validation_and_privacy(client):
    signup(client)
    hours(T0, 24 * 5)
    assert client.post("/practice/sessions", json={"tf": "1h", "start": "2025-03-05"}).status_code == 422
    assert client.post("/practice/sessions", json={"tf": "1h", "start": "2025-03-05", "end": "2025-03-04"}).status_code == 422
    assert client.post("/practice/sessions", json={"tf": "1h", "start": "2019-01-01", "end": "2019-02-01"}).status_code == 422
    assert client.post("/practice/sessions", json={"tf": "5m"}).status_code == 404  # no minute data
    s = client.post("/practice/sessions", json={"tf": "1h", "start": "2025-03-03", "end": "2025-03-07"}).json()
    assert client.put(f"/practice/sessions/{s['id']}", json={"state": {"x": "y" * 300_000}}).status_code == 413
    client.post("/auth/logout")
    signup(client, "other@example.com")
    assert client.get(f"/practice/sessions/{s['id']}").status_code == 404
