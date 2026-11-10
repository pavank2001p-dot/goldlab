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
    assert paper.DEFAULT_LEVERAGE == 20 and 500 in paper.LEVERAGES


def test_assistant_paper_tool(client):
    from app import assistant

    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    client.post("/paper/orders", json={"side": "short", "units": 3, "stop_loss": 2050})
    uid = client.get("/auth/me").json()["id"]
    out, err = assistant.call_tool("my_paper_account", {}, uid)
    assert not err and '"open_positions": [{"side": "short"' in out


def test_leverage_sets_margin(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    # 1:1 means the position can't be worth more than the account: 5 oz x 2000 = 10,000 fits, 6 oz doesn't.
    s = client.post("/paper/reset", json={"balance": 10_000, "leverage": 1}).json()
    assert s["account"]["leverage"] == 1 and s["settings"]["margin_rate_pct"] == 100
    assert client.post("/paper/orders", json={"side": "long", "units": 6}).status_code == 422
    pid = client.post("/paper/orders", json={"side": "long", "units": 4}).json()["position"]["id"]
    assert client.get("/paper").json()["account"]["margin_used"] == 8000

    # Raising leverage frees margin on the open position at once.
    s = client.patch("/paper/settings", json={"leverage": 500}).json()
    assert s["account"]["margin_used"] == 16 and s["account"]["leverage"] == 500
    # At 1:500 the same $10,000 can open 2,000 oz (worth $4m).
    assert client.post("/paper/orders", json={"side": "long", "units": 2000}).status_code == 201
    # Dropping back to 1:1 would need $4m of margin, so it is refused.
    r = client.patch("/paper/settings", json={"leverage": 1})
    assert r.status_code == 422 and "1:1" in r.json()["detail"]
    assert client.patch("/paper/settings", json={"leverage": 1001}).status_code == 422
    assert client.post(f"/paper/positions/{pid}/close").status_code == 200


def test_any_balance_and_funds(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    s = client.post("/paper/reset", json={"balance": 250_000_000, "leverage": 100}).json()
    assert s["account"]["balance"] == 250_000_000 and s["account"]["leverage"] == 100
    assert client.post("/paper/reset", json={"balance": 10**13}).status_code == 422

    s = client.post("/paper/funds", json={"amount": 50_000_000}).json()
    assert s["account"]["balance"] == 300_000_000 and s["account"]["starting_balance"] == 300_000_000
    assert s["account"]["return_pct"] == 0

    client.post("/paper/reset", json={"balance": 1000, "leverage": 10})
    client.post("/paper/orders", json={"side": "long", "units": 4})  # $800 margin
    r = client.post("/paper/funds", json={"amount": -500})
    assert r.status_code == 422 and "at most" in r.json()["detail"]
    s = client.post("/paper/funds", json={"amount": -100}).json()
    assert s["account"]["balance"] == 900
    assert client.post("/paper/funds", json={"amount": 0}).status_code == 422


def test_move_pending_order(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    o = client.post("/paper/orders", json={"side": "long", "kind": "limit", "units": 5, "price": 1995,
                                           "stop_loss": 1985, "take_profit": 2010}).json()["order"]
    # Dragging the entry line down keeps the stop and target.
    r = client.patch(f"/paper/orders/{o['id']}", json={"price": 1992})
    assert r.status_code == 200
    m = r.json()["order"]
    assert m["price"] == 1992 and m["stop_loss"] == 1985 and m["take_profit"] == 2010
    # A buy limit can't be moved above the ask, and the stop must stay below the entry.
    assert client.patch(f"/paper/orders/{o['id']}", json={"price": 2005}).status_code == 422
    assert client.patch(f"/paper/orders/{o['id']}", json={"stop_loss": 1993}).status_code == 422
    # Moving the target, then removing it.
    assert client.patch(f"/paper/orders/{o['id']}", json={"take_profit": 2020}).json()["order"]["take_profit"] == 2020
    m = client.patch(f"/paper/orders/{o['id']}", json={"take_profit": None}).json()["order"]
    assert m["take_profit"] is None and m["stop_loss"] == 1985

    bar(1, 1999, 1999, 1993.5, 1996)  # ask low 1993.8 doesn't reach 1992
    s = client.get("/paper").json()
    assert len(s["orders"]) == 1 and s["positions"] == []
    bar(2, 1995, 1995, 1990, 1991)  # ask low 1990.3 does
    s = client.get("/paper").json()
    assert s["orders"] == [] and s["positions"][0]["entry_price"] == 1992

    assert client.patch(f"/paper/orders/{o['id']}", json={"price": 1990}).status_code == 404
