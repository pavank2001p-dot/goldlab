"""Broker-style order tools: trailing stop, break-even, partial close and one-cancels-other."""

import pytest

from app.live import feed
from tests.test_paper import bar, signup


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def test_trailing_stop_follows_and_closes(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    p = client.post("/paper/orders", json={"side": "long", "units": 1, "trail": 10}).json()["position"]
    assert p["trail"] == 10 and p["stop_loss"] == 1990  # bid 2000 minus 10

    bar(1, 2000, 2030, 2000, 2025)  # high 2030 pulls the stop up to 2020
    s = client.get("/paper").json()
    assert s["positions"][0]["stop_loss"] == 2020
    bar(2, 2025, 2026, 2015, 2018)  # a new high of 2026 is lower, so the stop stays; low 2015 hits 2020
    h = client.get("/paper").json()["history"][0]
    assert h["close_reason"] == "stop_loss" and h["exit_price"] == 2020
    assert h["pnl"] == round(2020 - 2000.3, 2)


def test_trailing_stop_short_and_turn_on_later(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    pid = client.post("/paper/orders", json={"side": "short", "units": 2}).json()["position"]["id"]
    r = client.patch(f"/paper/positions/{pid}", json={"stop_loss": None, "take_profit": None, "trail": 5})
    assert r.status_code == 200 and r.json()["position"]["stop_loss"] == 2005.3  # ask 2000.3 plus 5
    bar(1, 1999, 1999, 1980, 1982)  # ask low 1980.3 pulls the stop down to 1985.3
    assert client.get("/paper").json()["positions"][0]["stop_loss"] == 1985.3
    # Moving the target leaves the trail on.
    r = client.patch(f"/paper/positions/{pid}", json={"stop_loss": 1985.3, "take_profit": 1950})
    assert r.status_code == 200, r.json()
    assert r.json()["position"]["trail"] == 5
    # Turning it off keeps the stop where it is.
    r = client.patch(f"/paper/positions/{pid}", json={"stop_loss": 1985.3, "take_profit": 1950, "trail": None})
    assert r.json()["position"]["trail"] is None and r.json()["position"]["stop_loss"] == 1985.3


def test_breakeven(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    pid = client.post("/paper/orders", json={"side": "long", "units": 1, "stop_loss": 1990}).json()["position"]["id"]
    # Still below the entry (2000.3), so the stop can't go there yet.
    assert client.post(f"/paper/positions/{pid}/breakeven").status_code == 422
    bar(1, 2005, 2010, 2004, 2008)
    r = client.post(f"/paper/positions/{pid}/breakeven")
    assert r.status_code == 200 and r.json()["position"]["stop_loss"] == 2000.3


def test_partial_close(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    pid = client.post("/paper/orders", json={"side": "long", "units": 10, "stop_loss": 1990}).json()["position"]["id"]
    bar(1, 2010, 2011, 2009, 2010)
    assert client.post(f"/paper/positions/{pid}/close", json={"units": 11}).status_code == 422
    part = client.post(f"/paper/positions/{pid}/close", json={"units": 4}).json()["position"]
    assert part["id"] != pid and part["units"] == 4 and part["close_reason"] == "partial"
    assert part["pnl"] == round((2010 - 2000.3) * 4, 2)
    s = client.get("/paper").json()
    assert s["positions"][0]["id"] == pid and s["positions"][0]["units"] == 6 and s["positions"][0]["stop_loss"] == 1990
    assert s["account"]["balance"] == round(10_000 + part["pnl"], 2)
    # Closing the rest with no body closes it all.
    rest = client.post(f"/paper/positions/{pid}/close").json()["position"]
    assert rest["units"] == 6 and rest["close_reason"] == "manual"
    assert client.get("/paper/report").json()["stats"]["trades"] == 2


def test_one_cancels_other(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    a = client.post("/paper/orders", json={"side": "long", "kind": "stop", "units": 1, "price": 2010}).json()["order"]
    b = client.post("/paper/orders", json={"side": "short", "kind": "stop", "units": 1, "price": 1990,
                                           "oco_with": a["id"]}).json()["order"]
    assert b["oco_id"] == a["id"]
    assert client.get("/paper").json()["orders"][0]["oco_id"] == b["id"]
    # A third order can't join a pair, and market orders can't be paired.
    assert client.post("/paper/orders", json={"side": "long", "kind": "limit", "units": 1, "price": 1980,
                                              "oco_with": a["id"]}).status_code == 422
    assert client.post("/paper/orders", json={"side": "long", "units": 1, "oco_with": a["id"]}).status_code == 422

    bar(1, 2000, 2015, 1999, 2012)  # breaks up through 2010: the buy stop fills, the sell stop is cancelled
    s = client.get("/paper").json()
    assert len(s["positions"]) == 1 and s["positions"][0]["side"] == "long" and s["orders"] == []
    assert s["cancelled_orders"][0]["note"] == "Its one-cancels-other partner filled"


def test_trailing_pending_order(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    client.post("/paper/orders", json={"side": "long", "kind": "limit", "units": 1, "price": 1995, "trail": 8})
    bar(1, 1999, 1999, 1994, 1996)  # fills at 1995; the trail starts from the fill's bid, 1994.7 - 8
    p = client.get("/paper").json()["positions"][0]
    assert p["trail"] == 8 and p["stop_loss"] == 1986.7
