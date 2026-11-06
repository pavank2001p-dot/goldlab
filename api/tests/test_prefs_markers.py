def signup(client, email="s@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def test_prefs_follow_the_account(client):
    signup(client)
    assert client.get("/prefs").json() == {}
    d = [{"id": "a", "kind": "hline", "a": {"t": 1, "p": 2000}, "color": "accent"}]
    assert client.put("/prefs/drawings", json={"value": d}).status_code == 200
    client.put("/prefs/indicators", json={"value": ["rsi"]})
    client.put("/prefs/indicators", json={"value": ["rsi", "bb"]})
    assert client.get("/prefs").json() == {"drawings": d, "indicators": ["rsi", "bb"]}
    assert client.put("/prefs/secret", json={"value": 1}).status_code == 422
    assert client.put("/prefs/drawings", json={"value": "x" * 300_000}).status_code == 413
    client.post("/auth/logout")
    assert client.get("/prefs").status_code == 401


def test_markers_mix_history_and_calendar(client):
    from datetime import datetime, timezone
    a = int(datetime(2020, 3, 1, tzinfo=timezone.utc).timestamp())
    b = int(datetime(2020, 4, 1, tzinfo=timezone.utc).timestamp())
    m = client.get(f"/calendar/markers?start={a}&end={b}").json()
    assert [e["title"] for e in m][:1] == ["Fed makes an emergency half-point cut"]
    assert all(e["kind"] == "fed" and e["history"] for e in m)
    from app import db
    with db.conn() as c:
        c.execute("INSERT INTO events (ts, title, impact, source) VALUES ('2030-01-10T13:30Z', 'CPI m/m', 'High', 't'),"
                  " ('2030-01-11T13:30Z', 'Some speech', 'Low', 't')")
    now = datetime(2030, 1, 10, tzinfo=timezone.utc)
    soon = [e for e in client.get(f"/calendar/markers?start={int(now.timestamp()) - 86400 * 400}&end={int(now.timestamp()) + 86400 * 400}").json()
            if not e["history"]]
    assert [(e["title"], e["kind"]) for e in soon] == [("CPI m/m", "inflation")]
