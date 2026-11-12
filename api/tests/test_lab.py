from datetime import datetime, timedelta, timezone

import pytest
from psycopg.types.json import Jsonb

from app import db, lab, learn, risk
from app.live import feed

from .test_paper import bar, signup


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def test_laps_count_stages_only_in_order():
    t0 = datetime(2026, 11, 1, tzinfo=timezone.utc)
    at = lambda h: t0 + timedelta(hours=h)  # noqa: E731
    # Review before anything else and a second Spark don't move the lap on.
    events = [(at(0), "review"), (at(1), "spark"), (at(2), "spark"), (at(3), "build"), (at(4), "test")]
    done, stage, cur = lab.laps(events)
    assert (done, stage) == (0, 3) and cur[0] == at(1) and cur[3] is None
    events += [(at(5), "play"), (at(6), "review"), (at(7), "spark")]
    done, stage, cur = lab.laps(list(reversed(events)))  # order of the input doesn't matter
    assert (done, stage) == (1, 1) and cur[0] == at(7)
    assert lab.laps([]) == (0, 0, [None] * 5)


def test_levels_follow_xp():
    assert lab.level_of(0)["name"] == "Apprentice" and lab.level_of(0)["next"] == {"name": "Analyst", "at": 300}
    assert lab.level_of(300)["name"] == "Analyst"
    assert lab.level_of(5000)["name"] == "Market-ready" and lab.level_of(5000)["next"] is None


def lab_of(client):
    r = client.get("/lab")
    assert r.status_code == 200, r.text
    return r.json()


def user_id():
    with db.conn() as c:
        return c.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1").fetchone()["id"]


def test_lab_walks_one_lap(client):
    assert client.get("/lab").status_code == 401
    signup(client, "lab@example.com")
    d = lab_of(client)
    assert d["mission"]["stage"] == "limits" and d["mission"]["href"] == "/risk"
    assert d["xp"] == 0 and d["level"]["name"] == "Apprentice" and d["laps"] == 0

    answers = {q["key"]: 1 for q in risk.QUESTIONS}
    assert client.post("/risk/profile", json={"answers": answers}).status_code in (200, 201)
    d = lab_of(client)
    first = learn.LESSONS[0]
    assert d["mission"]["stage"] == "spark" and d["mission"]["href"] == f"/learn/{first['id']}"
    assert d["stages"][0]["state"] == "current" and d["xp"] == 75  # the limits step and its badge

    # Spark: finish a lesson. The next mission is to build, and the next lesson waits in "where you left off".
    assert client.post(f"/learn/{first['id']}/complete", json={"return_pct": 1.5, "trades": 2}).status_code in (200, 201)
    d = lab_of(client)
    assert d["mission"]["stage"] == "build" and d["mission"]["href"] == "/strategies/builder"
    assert d["stages"][0]["state"] == "done"
    assert any(r["href"] == f"/learn/{learn.LESSONS[1]['id']}" for r in d["resume"])

    uid = user_id()
    with db.conn() as c:  # Build, then Test, written straight to the tables they come from.
        sid = c.execute("INSERT INTO custom_strategies (user_id, rules) VALUES (%s, %s) RETURNING id",
                        (uid, Jsonb({"name": "Dip buyer"}))).fetchone()["id"]
    d = lab_of(client)
    assert d["mission"]["stage"] == "test"
    assert d["stages"][1]["href"] == f"/strategies/builder?id={sid}" and "Dip buyer" in d["stages"][1]["title"]
    with db.conn() as c:
        c.execute("INSERT INTO backtests (user_id, params, stats, result) VALUES (%s, '{}', '{}', '{}')", (uid,))
    d = lab_of(client)
    assert d["mission"]["stage"] == "play" and d["mission"]["href"] == "/paper/challenge"

    # Play: a paper trade with a stop inside the limit earns XP for both.
    bar(-2, 2000, 2001, 1999, 2000)
    assert client.post("/paper/orders", json={"side": "long", "units": 10, "stop_loss": 1996}).status_code == 201
    d = lab_of(client)
    assert d["mission"]["stage"] == "review" and d["mission"]["href"] == "/coach"
    src = {s["key"]: s for s in d["sources"]}
    assert src["stop_trade"]["count"] == 1 and src["inside_trade"]["count"] == 1
    assert d["resume"][0]["href"] == "/paper" and "1 open paper trade" in d["resume"][0]["title"]

    # Review: a note in the journal closes the lap, and the next one starts at Spark.
    now = datetime.now(timezone.utc)
    r = client.post("/trades", json={"side": "long", "units": 1, "open_time": now.isoformat(), "open_price": 2000,
                                     "notes": "Waited for my level"})
    assert r.status_code == 201, r.text
    d = lab_of(client)
    assert d["laps"] == 1 and d["mission"]["stage"] == "spark"
    assert all(s["state"] != "done" for s in d["stages"])
    src = {s["key"]: s for s in d["sources"]}
    assert src["lap"]["xp"] == 100
    assert d["xp"] == sum(s["xp"] for s in d["sources"])


def test_xp_caps_each_habit(client):
    signup(client, "cap@example.com")
    uid = user_id()
    with db.conn() as c:
        for _ in range(lab.XP["backtest"][1] + 20):
            c.execute("INSERT INTO backtests (user_id, params, stats, result) VALUES (%s, '{}', '{}', '{}')", (uid,))
    src = {s["key"]: s for s in lab_of(client)["sources"]}
    assert src["backtest"]["count"] == 50 and src["backtest"]["xp"] == lab.XP["backtest"][0] * lab.XP["backtest"][1]
