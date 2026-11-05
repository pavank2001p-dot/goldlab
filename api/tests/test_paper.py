from datetime import datetime, timedelta, timezone

import pytest

from app import db, paper
from app.live import feed


def signup(client, email="p@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def bar(minutes_from_now: float, o: float, h: float, l: float, c: float, tf: str = "1m"):
    ts = (datetime.now(timezone.utc) + timedelta(minutes=minutes_from_now)).replace(second=0, microsecond=0)
    with db.conn() as conn:
        conn.execute(
            """INSERT INTO candles (symbol, tf, ts, open, high, low, close) VALUES ('XAUUSD', %s, %s, %s, %s, %s, %s)
               ON CONFLICT (symbol, tf, ts) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high,
               low = EXCLUDED.low, close = EXCLUDED.close""",
            (tf, ts, o, h, l, c))


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def test_market_order_open_and_close(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    s = client.get("/paper").json()
    assert s["account"]["balance"] == 10_000 and s["price"]["bid"] == 2000 and s["price"]["ask"] == 2000.3
    assert s["price"]["open"]

    r = client.post("/paper/orders", json={"side": "long", "units": 10, "stop_loss": 1990, "take_profit": 2020})
    assert r.status_code == 201
    p = r.json()["position"]
    assert p["entry_price"] == 2000.3

    s = client.get("/paper").json()
    assert len(s["positions"]) == 1 and s["positions"][0]["pnl"] == -3  # the spread
    assert s["account"]["margin_used"] == 10 * 2000 * 0.05
    assert s["account"]["equity"] == 9997

    closed = client.post(f"/paper/positions/{p['id']}/close").json()["position"]
    assert closed["pnl"] == -3 and closed["close_reason"] == "manual"
    s = client.get("/paper").json()
    assert s["account"]["balance"] == 9997 and s["positions"] == [] and len(s["history"]) == 1


def test_limit_order_fills_then_stop_loss(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    r = client.post("/paper/orders", json={"side": "long", "kind": "limit", "units": 5, "price": 1995, "stop_loss": 1985})
    assert r.status_code == 201 and r.json()["order"]["status"] == "pending"

    bar(1, 1999, 1999, 1994, 1996)  # ask low 1994.3 reaches the 1995 limit
    s = client.get("/paper").json()
    assert s["orders"] == [] and len(s["positions"]) == 1
    assert s["positions"][0]["entry_price"] == 1995 and s["positions"][0]["order_kind"] == "limit"

    bar(2, 1990, 1991, 1980, 1982)  # bid low reaches the 1985 stop
    s = client.get("/paper").json()
    assert s["positions"] == []
    h = s["history"][0]
    assert h["close_reason"] == "stop_loss" and h["exit_price"] == 1985 and h["pnl"] == -50
    assert s["account"]["balance"] == 9950


def test_short_stop_order_and_take_profit_with_gap(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    client.post("/paper/orders", json={"side": "short", "kind": "stop", "units": 2, "price": 1990, "take_profit": 1950})
    bar(1, 1992, 1993, 1985, 1986)  # falls through 1990: sells at the stop price
    bar(2, 1940, 1945, 1938, 1944)  # gaps below the target: buys back at the open plus spread
    s = client.get("/paper").json()
    h = s["history"][0]
    assert h["entry_price"] == 1990 and h["exit_price"] == 1940.3 and h["close_reason"] == "take_profit"
    assert h["pnl"] == round((1990 - 1940.3) * 2, 2)


def test_validation(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    bad = [
        {"side": "long", "kind": "limit", "units": 1, "price": 2010},  # buy limit above the ask
        {"side": "short", "kind": "limit", "units": 1, "price": 1990},  # sell limit below the bid
        {"side": "long", "kind": "stop", "units": 1, "price": 1990},  # buy stop below the ask
        {"side": "long", "units": 1, "stop_loss": 2005},  # stop above a buy
        {"side": "short", "units": 1, "take_profit": 2005},  # target above a sell
        {"side": "long", "units": 10_000},  # far more than the margin allows
    ]
    for body in bad:
        r = client.post("/paper/orders", json=body)
        assert r.status_code == 422, body
    assert client.post("/paper/orders", json={"side": "long", "kind": "limit", "units": 1}).status_code == 422
    assert client.get("/paper").json()["positions"] == []


def test_market_closed_allows_pending_orders_only(client):
    signup(client)
    bar(-60 * 10, 2000, 2001, 1999, 2000)  # ten hours old
    s = client.get("/paper").json()
    assert s["price"]["open"] is False
    assert client.post("/paper/orders", json={"side": "long", "units": 1}).status_code == 409
    assert client.post("/paper/orders", json={"side": "long", "kind": "limit", "units": 1, "price": 1990}).status_code == 201
    oid = client.get("/paper").json()["orders"][0]["id"]
    assert client.delete(f"/paper/orders/{oid}").status_code == 204
    s = client.get("/paper").json()
    assert s["orders"] == [] and s["cancelled_orders"][0]["note"] == "Cancelled by you"


def test_stop_out(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    client.post("/paper/reset", json={"balance": 1000})
    assert client.post("/paper/orders", json={"side": "long", "units": 9}).status_code == 201  # 900 margin
    bar(1, 1960, 1960, 1925, 1930)  # loses about 630, leaving equity below half the margin
    s = client.get("/paper").json()
    assert s["positions"] == [] and s["history"][0]["close_reason"] == "stop_out"


def test_edit_protection_report_and_reset(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    pid = client.post("/paper/orders", json={"side": "long", "units": 1}).json()["position"]["id"]
    assert client.patch(f"/paper/positions/{pid}", json={"stop_loss": 2010}).status_code == 422
    r = client.patch(f"/paper/positions/{pid}", json={"stop_loss": 1990, "take_profit": 2030})
    assert r.status_code == 200 and r.json()["position"]["take_profit"] == 2030
    bar(1, 2010, 2035, 2009, 2032)
    rep = client.get("/paper/report").json()
    assert rep["stats"]["trades"] == 1 and rep["trades"][0]["pnl"] == round(2030 - 2000.3, 2)
    assert rep["capital"] == 10_000

    assert client.get("/paper/fit").status_code == 404  # no risk profile yet

    s = client.post("/paper/reset", json={"balance": 50_000}).json()
    assert s["account"]["balance"] == 50_000 and s["history"] == [] and s["positions"] == []


def test_needs_login(client):
    assert client.get("/paper").status_code == 401
    assert paper.MARGIN_RATE == 0.05


def test_assistant_paper_tool(client):
    from app import assistant

    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    client.post("/paper/orders", json={"side": "short", "units": 3, "stop_loss": 2050})
    uid = client.get("/auth/me").json()["id"]
    out, err = assistant.call_tool("my_paper_account", {}, uid)
    assert not err and '"open_positions": [{"side": "short"' in out
