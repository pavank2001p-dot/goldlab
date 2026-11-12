import pytest

from app import db, record
from app.live import feed
from tests.test_paper import bar, signup


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def trade(client, side="long", stop=True):
    body = {"side": side, "units": 10}
    if stop:
        body["stop_loss"] = 1990 if side == "long" else 2010
    p = client.post("/paper/orders", json=body).json()["position"]
    return client.post(f"/paper/positions/{p['id']}/close").json()["position"]


def test_trades_are_sealed_into_a_chain_that_survives_reset(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    trade(client)
    trade(client, "short", stop=False)
    r = client.get("/record").json()
    assert r["chain"]["ok"] and r["chain"]["entries"] == 3  # start + two trades
    assert r["stats"]["trades"] == 2 and r["stats"]["stop_pct"] == 50

    assert client.post("/paper/reset", json={"balance": 50_000, "leverage": 20}).status_code == 200
    r = client.get("/record").json()
    assert r["stats"]["trades"] == 2  # a reset doesn't wipe the record
    assert [e["kind"] for e in r["recent"]][:1] == ["reset"]
    assert r["chain"]["ok"]


def test_report_verifies_and_detects_tampering(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    assert client.post("/record/reports", json={}).status_code == 422  # nothing to report yet
    trade(client)
    rep = client.post("/record/reports", json={"display_name": "Pavan"}).json()
    v = client.get(f"/record/verify/{rep['id']}").json()
    assert v["status"] == "verified" and v["display_name"] == "Pavan" and v["stats"]["trades"] == 1
    assert "email" not in str(v)

    # Later trades don't change an issued report.
    trade(client)
    assert client.get(f"/record/verify/{rep['id']}").json()["status"] == "verified"

    # Editing a sealed trade breaks the chain.
    with db.conn() as c:
        c.execute("UPDATE record_entries SET data = jsonb_set(data, '{pnl}', '500') WHERE seq = 2")
    v = client.get(f"/record/verify/{rep['id']}").json()
    assert v["status"] == "altered" and not v["checks"]["chain"]


def test_snapshot_edit_breaks_signature(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    trade(client)
    rep = client.post("/record/reports", json={}).json()
    with db.conn() as c:
        c.execute("UPDATE record_reports SET snapshot = jsonb_set(snapshot, '{stats,return_pct}', '90') WHERE id = %s",
                  (rep["id"],))
    v = client.get(f"/record/verify/{rep['id']}").json()
    assert v["status"] == "altered" and not v["checks"]["signature"]


def test_revoke_hides_the_report(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    trade(client)
    rep = client.post("/record/reports", json={}).json()
    assert client.delete(f"/record/reports/{rep['id']}").status_code == 204
    v = client.get(f"/record/verify/{rep['id']}").json()
    assert v["status"] == "revoked" and "stats" not in v
    assert client.get("/record/verify/nope").status_code == 404


def test_passport_levels():
    base = {"trades": 0, "days": 0, "stop_pct": 0, "kept_stop_pct": 0, "max_dd": 0, "worst_loss": 0,
            "profit_factor": None, "prop_passed": 0}
    assert record.passport(base)["level"] is None
    bronze = {**base, "trades": 25, "days": 5, "stop_pct": 85, "kept_stop_pct": 100, "max_dd": 12, "worst_loss": 4}
    p = record.passport(bronze)
    assert p["level"]["key"] == "bronze" and p["next"]["key"] == "silver"
    gold = {**base, "trades": 120, "days": 30, "stop_pct": 100, "kept_stop_pct": 100, "max_dd": 6, "worst_loss": 1.5,
            "profit_factor": 1.4, "prop_passed": 1}
    p = record.passport(gold)
    assert p["level"]["key"] == "gold" and p["next"] is None
    # Gold's numbers without a passed challenge stop at Silver.
    assert record.passport({**gold, "prop_passed": 0})["level"]["key"] == "silver"


def test_stats_compound_across_resets():
    def t(pnl, before, agent=False):
        return {"kind": "trade", "data": {"pnl": pnl, "balance_before": before, "closed_at": "2026-11-10T15:00:00+00:00",
                                          "symbol": "XAUUSD", "stop_loss": 1.0, "agent": agent}}
    rows = [t(100, 10_000), t(-50, 1_000), t(999, 10_000, agent=True)]
    s = record.stats(rows)
    assert s["trades"] == 2 and s["agent_trades"] == 1
    assert s["return_pct"] == pytest.approx((1.01 * 0.95 - 1) * 100, abs=0.01)
    assert s["worst_loss"] == 5.0 and s["max_dd"] == 5.0
