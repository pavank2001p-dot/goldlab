"""The disciplined twin: the same paper trades taken by a copy that keeps the rules, and session days."""

from datetime import timedelta

from app import db, twin
from tests.test_coach import NOW, no_live_feed, trade, uid  # noqa: F401  (fixture used by every test)
from tests.test_paper import signup


def candle(ts, h, l):
    with db.conn() as c:
        c.execute("INSERT INTO candles (symbol, tf, ts, open, high, low, close) VALUES ('XAUUSD', '1m', %s, %s, %s, %s, %s)",
                  (ts, (h + l) / 2, h, l, (h + l) / 2))


def test_clean_trades_match(client):
    signup(client)
    u = uid(client)
    t0 = NOW - timedelta(days=2)
    trade(u, t0, t0 + timedelta(minutes=20), -10)
    trade(u, t0 + timedelta(hours=2), t0 + timedelta(hours=3), 25)
    r = client.get("/coach/twin").json()
    assert r["you"] == r["twin"] == 15 and r["costs"] == []
    assert [p["you"] for p in r["curve"]] == [-10, 15]
    assert r["days"][0]["trades"] == 2 and r["days"][0]["broken"] == 0


def test_twin_skips_revenge_and_sizes_down(client):
    signup(client)
    u = uid(client)
    t0 = NOW - timedelta(days=2)
    trade(u, t0, t0 + timedelta(minutes=20), -10)
    trade(u, t0 + timedelta(minutes=25), t0 + timedelta(minutes=40), -40)               # revenge: twin skips
    trade(u, t0 + timedelta(hours=5), t0 + timedelta(hours=6), -300, units=30)           # 3% risk, limit 1%
    r = client.get("/coach/twin").json()
    costs = {c["tag"]: c["cost"] for c in r["costs"]}
    assert costs["revenge"] == -40
    # Equity was 9,950 by then, so 1% is 99.50: the twin loses that instead of 300.
    assert costs["oversized"] == -200.5
    assert r["you"] == -350 and r["twin"] == -109.5


def test_twin_keeps_the_planned_stop(client):
    signup(client)
    u = uid(client)
    t0 = (NOW - timedelta(days=1)).replace(second=0, microsecond=0)
    pid = trade(u, t0, t0 + timedelta(minutes=30), -40, stop=1960)   # stop was 1990, moved to 1960
    with db.conn() as c:
        c.execute("UPDATE paper_positions SET stop_widened = true, planned_stop = 1990 WHERE id = %s", (pid,))
    candle(t0 + timedelta(minutes=5), 2001, 1995)
    candle(t0 + timedelta(minutes=10), 1996, 1985)     # touches the planned 1990
    r = client.get("/coach/twin").json()
    t = r["trades"][0]
    assert t["twin_pnl"] == -10 and "planned stop" in t["rule"]
    assert r["costs"] == [{"tag": "stop_widened", "label": "Stop moved away", "cost": -30, "trades": 1}]


def test_no_stop_uses_a_stop_at_the_limit():
    t = {"pnl": -250.0, "tags": ["no_stop"], "side": "long", "entry_price": 2000.0, "units": 10.0, "stop_loss": None}
    bars = [{"high": 2001, "low": 1975}]
    r = twin.replay(t, bars, 1.0, 10_000)             # 1% of 10k at 10 oz: stop 10 below
    assert r["pnl"] == -100 and r["costs"] == {"no_stop": -150}
    assert twin.replay(t, [{"high": 2001, "low": 1995}], 1.0, 10_000)["pnl"] == -250


def test_widened_stop_survives_a_partial_close(client):
    signup(client)
    from tests.test_paper import bar
    bar(-2, 2000, 2001, 1999, 2000)
    pid = client.post("/paper/orders", json={"side": "long", "units": 2, "stop_loss": 1990}).json()["position"]["id"]
    client.patch(f"/paper/positions/{pid}", json={"stop_loss": 1980})
    client.post(f"/paper/positions/{pid}/close", json={"units": 1})
    with db.conn() as c:
        rows = c.execute("SELECT planned_stop, stop_widened FROM paper_positions ORDER BY id").fetchall()
    assert all(r["planned_stop"] == 1990 and r["stop_widened"] for r in rows) and len(rows) == 2
