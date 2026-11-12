"""The AI coach: mistake tags, the playbook and pre-trade check, and the weekly report (rules, no API key)."""

from datetime import datetime, timedelta, timezone

import pytest

from app import coach, db
from app.live import feed
from tests.test_paper import bar, signup

NOW = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def uid(client) -> int:
    return client.get("/auth/me").json()["id"]


def trade(user_id, opened, closed, pnl, stop=1990.0, units=1.0, reason="manual", side="long", entry=2000.0):
    with db.conn() as c:
        c.execute("INSERT INTO paper_accounts (user_id, starting_balance, balance) VALUES (%s, 10000, 10000) "
                  "ON CONFLICT DO NOTHING", (user_id,))
        return c.execute(
            "INSERT INTO paper_positions (user_id, side, units, entry_price, opened_at, stop_loss, closed_at, exit_price, "
            "close_reason, swap, pnl) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s) RETURNING id",
            (user_id, side, units, entry, opened, stop, closed, entry + pnl / units, reason, pnl)).fetchone()["id"]


def test_tags(client):
    signup(client)
    u = uid(client)
    t0 = NOW - timedelta(days=2)
    clean = trade(u, t0, t0 + timedelta(minutes=20), -10)                                       # 0.1% risk, fine
    revenge = trade(u, t0 + timedelta(minutes=30), t0 + timedelta(minutes=40), 5)               # 10 min after a loss
    nostop = trade(u, t0 + timedelta(hours=3), t0 + timedelta(hours=4), 3, stop=None)
    big = trade(u, t0 + timedelta(hours=5), t0 + timedelta(hours=6), -300, units=30)            # 300/10k = 3% > 1%
    out = trade(u, t0 + timedelta(hours=8), t0 + timedelta(hours=9), -900, units=5, reason="stop_out")
    with db.conn() as c:
        c.execute("INSERT INTO events (ts, title, impact, source) VALUES (%s, 'CPI m/m', 'High', 't')",
                  (t0 + timedelta(hours=8, minutes=10),))
    r = client.get("/coach/tags").json()
    by = r["by_trade"]
    assert by[str(clean)] == [] and by[str(revenge)] == ["revenge"] and by[str(nostop)] == ["no_stop"]
    assert by[str(big)] == ["oversized"] and set(by[str(out)]) == {"red_folder", "stop_out"}
    assert r["counts"]["revenge"] == 1 and r["clean"] == 1 and r["trades"] == 5
    assert r["labels"]["stop_widened"]["label"] == "Stop moved away"


def test_stop_widened_flag(client):
    signup(client)
    bar(-2, 2000, 2001, 1999, 2000)
    pid = client.post("/paper/orders", json={"side": "long", "units": 1, "stop_loss": 1990}).json()["position"]["id"]
    client.patch(f"/paper/positions/{pid}", json={"stop_loss": 1995})   # tighter: fine
    client.post(f"/paper/positions/{pid}/close")
    pid2 = client.post("/paper/orders", json={"side": "long", "units": 1, "stop_loss": 1990}).json()["position"]["id"]
    client.patch(f"/paper/positions/{pid2}", json={"stop_loss": 1980})  # further away: flagged
    client.post(f"/paper/positions/{pid2}/close")
    by = client.get("/coach/tags").json()["by_trade"]
    assert "stop_widened" not in by[str(pid)] and "stop_widened" in by[str(pid2)]


def test_playbook_and_pretrade(client):
    signup(client)
    r = client.get("/coach/playbook").json()
    assert r["custom"] is False and r["rules"] == coach.DEFAULT_RULES
    r = client.put("/coach/playbook", json={"rules": ["  Trade only with the 4h trend ", "", "No trades on Fridays"]}).json()
    assert r["rules"] == ["Trade only with the 4h trend", "No trades on Fridays"]
    assert client.put("/coach/playbook", json={"rules": ["x"] * 13}).status_code == 422

    u = uid(client)
    trade(u, NOW - timedelta(minutes=20), NOW - timedelta(minutes=5), -42.5)
    with db.conn() as c:
        c.execute("INSERT INTO events (ts, title, impact, source) VALUES (%s, 'Nonfarm payrolls', 'High', 't')",
                  (NOW + timedelta(minutes=15),))
    p = client.get("/coach/pretrade").json()
    assert p["rules"][0] == "Trade only with the 4h trend"
    keys = [w["key"] for w in p["warnings"]]
    assert "revenge" in keys and "red_folder" in keys
    assert "42.50" in p["warnings"][0]["text"]


def test_weekly_report_rules(client):
    signup(client)
    u = uid(client)
    week = coach.iso_week((NOW - timedelta(days=14)).date())
    start, _ = coach.week_bounds(week)
    prev_start = start - timedelta(days=7)
    trade(u, prev_start + timedelta(hours=10), prev_start + timedelta(hours=11), -5, stop=None)
    trade(u, prev_start + timedelta(hours=12), prev_start + timedelta(hours=13), -5, stop=None)
    trade(u, start + timedelta(hours=10), start + timedelta(hours=11), 20)
    trade(u, start + timedelta(hours=11, minutes=5), start + timedelta(hours=12), -8)
    trade(u, start + timedelta(hours=12, minutes=10), start + timedelta(hours=13), 4)  # revenge: 10 min after a loss

    r = client.get(f"/coach/weekly?week={week}").json()
    assert r["finished"] and r["source"] == "rules" and len(r["trades"]) == 3
    assert r["facts"]["this_week"]["tags"] == {"revenge": 1} and r["facts"]["week_before"]["tags"] == {"no_stop": 2}
    assert r["work_on"].startswith("Revenge trade: 1 trade")
    assert any("Every trade had a stop loss" in g for g in r["went_well"])
    assert "30 minutes" in r["next_week_goal"]
    # A finished week is saved and served as it was.
    with db.conn() as c:
        assert c.execute("SELECT count(*) AS n FROM coach_reports").fetchone()["n"] == 1
    trade(u, start + timedelta(hours=20), start + timedelta(hours=21), 100)
    assert len(client.get(f"/coach/weekly?week={week}").json()["trades"]) == 3

    # This week so far, with nothing closed yet.
    now = client.get("/coach/weekly").json()
    assert not now["finished"] and now["trades"] == [] and now["headline"].startswith("No practice trades")
    assert client.get("/coach/weekly?week=2999-W01").status_code == 422
    assert client.get("/coach/weekly?week=2026-W99").status_code == 422
