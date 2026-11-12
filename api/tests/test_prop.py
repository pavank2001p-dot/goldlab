import pytest

from app.live import feed

from .test_paper import bar, signup


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def custom(client, targets=(1.0,), daily=5.0, max_loss=10.0, min_days=0, size=10_000):
    r = client.post("/prop/start", json={"plan": "custom", "size": size, "custom": {
        "targets": list(targets), "daily_loss_pct": daily, "max_loss_pct": max_loss, "min_days": min_days, "leverage": 100}})
    assert r.status_code == 201, r.text
    return r.json()["current"]


def test_start_sets_account_and_locks_settings(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    client.post("/paper/orders", json={"side": "long", "units": 1})
    r = client.post("/prop/start", json={"plan": "two_step", "size": 50_000})
    assert r.status_code == 201
    ch = r.json()["current"]
    assert ch["status"] == "active" and ch["phase"] == 1 and ch["phases"] == 2 and ch["leverage"] == 100
    assert [k["key"] for k in ch["checks"]] == ["target", "daily_loss", "max_loss", "min_days"]
    assert ch["target_balance"] == 55_000 and ch["checks"][1]["floor"] == 47_500 and ch["checks"][2]["floor"] == 45_000

    s = client.get("/paper").json()
    assert s["account"]["balance"] == 50_000 and s["account"]["leverage"] == 100 and s["positions"] == []
    assert s["challenge"]["id"] == ch["id"]
    assert client.patch("/paper/settings", json={"leverage": 500}).status_code == 409
    assert client.post("/paper/funds", json={"amount": 1000}).status_code == 409
    assert client.post("/prop/start", json={"plan": "starter", "size": 50_000}).status_code == 422


def test_daily_loss_breach_fails_and_locks(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client)
    pid = client.post("/paper/orders", json={"side": "long", "units": 100, "stop_loss": 1900}).json()["position"]["id"]
    client.post("/paper/orders", json={"side": "long", "kind": "limit", "units": 1, "price": 1950})
    bar(1, 2000, 2000, 1994, 1999)  # worst equity 10,000 + (1994 - 2000.3) * 100 = 9,370, under the 9,500 floor
    s = client.get("/paper").json()
    assert s["positions"] == [] and s["orders"] == []
    h = s["history"][0]
    assert h["id"] == pid and h["close_reason"] == "challenge_daily_loss" and h["exit_price"] == 1994
    assert s["account"]["balance"] == 9370
    ch = s["challenge"]
    assert ch["status"] == "failed" and ch["fail_rule"] == "daily_loss" and ch["fail_help"]["lesson"]["id"]
    assert ch["final"]["max_drawdown_pct"] == 6.3
    r = client.post("/paper/orders", json={"side": "long", "units": 1})
    assert r.status_code == 409 and "ended" in r.json()["detail"]

    # Leaving the challenge reopens free practice with the same balance.
    assert client.post("/prop/leave").status_code == 200
    assert client.post("/paper/orders", json={"side": "long", "units": 1}).status_code == 201
    hist = client.get("/prop").json()
    assert hist["current"] is None and hist["history"][0]["status"] == "failed"


def test_overall_limit_checked_first(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client, daily=5, max_loss=5)
    client.post("/paper/orders", json={"side": "short", "units": 100})
    bar(1, 2000, 2006, 1999, 2001)  # buy back at 2006.3: -630
    ch = client.get("/prop").json()["history"][0]
    assert ch["status"] == "failed" and ch["fail_rule"] == "max_loss"


def test_recovering_inside_the_minute_still_breaks(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client)
    client.post("/paper/orders", json={"side": "long", "units": 100})
    bar(1, 2000, 2003, 1994, 2002)  # closes higher, but the low went through the floor
    assert client.get("/paper").json()["challenge"]["status"] == "failed"


def test_pass_needs_target_flat_and_days(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client, targets=(1.0,), min_days=1)
    pid = client.post("/paper/orders", json={"side": "long", "units": 100, "stop_loss": 1996}).json()["position"]["id"]
    bar(1, 2002, 2003, 2001, 2002)
    ch = client.get("/paper").json()["challenge"]
    assert ch["status"] == "active" and ch["warnings"] == [] and ch["checks"][3]["status"] == "done"
    assert client.post(f"/paper/positions/{pid}/close").status_code == 200  # +170
    s = client.get("/paper").json()
    assert s["challenge"]["status"] == "passed" and s["challenge"]["final"]["profit"] == 170
    assert s["locked"] and client.post("/paper/orders", json={"side": "long", "units": 1}).status_code == 409


def test_two_phases_start_fresh(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client, targets=(1.0, 1.0))
    pid = client.post("/paper/orders", json={"side": "long", "units": 100}).json()["position"]["id"]
    bar(1, 2002, 2003, 2001, 2002)
    client.post(f"/paper/positions/{pid}/close")
    s = client.get("/paper").json()
    ch = s["challenge"]
    assert ch["status"] == "active" and ch["phase"] == 2 and len(ch["phase_results"]) == 1
    assert ch["phase_results"][0]["profit"] == 170
    assert s["account"]["balance"] == 10_000 and s["history"] == []


def test_warnings_for_missing_stop(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client)
    client.post("/paper/orders", json={"side": "long", "units": 10})
    ch = client.get("/paper").json()["challenge"]
    assert ch["warnings"][0]["key"] == "no_stop" and ch["warnings"][0]["lesson"]["id"] == "2011-peak"
    client.post("/paper/orders", json={"side": "long", "units": 100, "stop_loss": 1990})
    # 10 oz without a stop still warns first; the stops check waits until every position has one.
    assert [w["key"] for w in client.get("/paper").json()["challenge"]["warnings"]] == ["no_stop"]


def test_stops_past_a_limit_warn(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client)
    client.post("/paper/orders", json={"side": "long", "units": 100, "stop_loss": 1990})  # -1,030 at the stop
    assert [w["key"] for w in client.get("/paper").json()["challenge"]["warnings"]] == ["stops_exceed"]


def test_reset_abandons(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client)
    assert client.post("/paper/reset", json={"balance": 5000, "leverage": 10}).status_code == 200
    data = client.get("/prop").json()
    assert data["current"] is None and data["history"][0]["status"] == "abandoned"
    assert len(data["plans"]) == 3


def test_new_trading_day_starts_from_that_balance():
    from datetime import date, datetime, timezone
    from types import SimpleNamespace

    from app.prop import Rules

    ch = {"day": date(2026, 1, 6), "day_start_balance": 10_000.0, "size": 10_000.0, "status": "active",
          "rules": {"daily_loss_pct": 5, "max_loss_pct": 10}}
    r, book = Rules(None, ch), SimpleNamespace(balance=9_800.0)
    r.roll(book, datetime(2026, 1, 6, 21, 59, tzinfo=timezone.utc))  # 16:59 New York: same day
    assert ch["day_start_balance"] == 10_000
    r.roll(book, datetime(2026, 1, 6, 22, 0, tzinfo=timezone.utc))  # 17:00 New York: the next trading day
    assert ch["day"] == date(2026, 1, 7) and ch["day_start_balance"] == 9_800
    assert r.floors() == (9_300, 9_000)


def test_trailing_stop_works_inside_a_challenge(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    custom(client)
    r = client.post("/paper/orders", json={"side": "long", "units": 10, "trail": 3})
    assert r.status_code == 201, r.text
    bar(1, 2000, 2010, 2000, 2009)  # the stop trails up to 2007
    bar(2, 2008, 2008, 2005, 2006)  # and closes the trade in profit
    s = client.get("/paper").json()
    assert s["positions"] == [] and s["history"][0]["close_reason"] == "stop_loss" and s["history"][0]["pnl"] > 0
    assert s["challenge"]["status"] == "active" and s["challenge"]["checks"][3]["value"] == 1
