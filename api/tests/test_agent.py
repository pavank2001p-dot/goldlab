import math
import random
from datetime import datetime, timedelta, timezone

import pytest

from app import agent, assistant, db, ingest
from app.live import feed
from app.risk import QUESTIONS

UTC = timezone.utc


def signup(client, email="a@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


@pytest.fixture(autouse=True)
def no_live_feed(monkeypatch):
    monkeypatch.setattr(feed, "price", None)
    monkeypatch.setattr(feed, "t", None)


def hourly(prices: list[float], end: datetime | None = None) -> datetime:
    """Closed hourly bars ending an hour before `end`, plus a fresh minute bar so the market is open."""
    end = (end or datetime.now(UTC)).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(hours=len(prices))
    bars = []
    for i, p in enumerate(prices):
        prev = prices[i - 1] if i else p
        bars.append(ingest.Bar(start + timedelta(hours=i), prev, max(prev, p) + 0.5, min(prev, p) - 0.5, p))
    ingest.upsert(bars, "1h")
    last = prices[-1]
    ingest.upsert([ingest.Bar(datetime.now(UTC).replace(second=0, microsecond=0) - timedelta(minutes=1), last, last, last, last)], "1m")
    return end


def daily(prices: list[float]):
    start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=len(prices))
    bars = []
    for i, p in enumerate(prices):
        prev = prices[i - 1] if i else p
        bars.append(ingest.Bar(start + timedelta(days=i), prev, max(prev, p) * 1.004, min(prev, p) * 0.996, p))
    ingest.upsert(bars, "1d")


def test_past_test_explains_losses_and_tests_fixes(client):
    signup(client)
    # Gold rises with daily noise of about 1%: shorts lose, and a 0.5% stop sits inside the noise.
    rnd, px, prices = random.Random(3), 1500.0, []
    for _ in range(900):
        px *= math.exp(rnd.gauss(0.002, 0.01))
        prices.append(px)
    daily(prices)
    r = client.post("/agent/past", json={"strategy": "ma_cross", "params": {"fast": 5, "slow": 12, "ema": 0},
                                         "years": 2.4, "stop_loss_pct": 0.5, "size_pct": 100})
    assert r.status_code == 200, r.text
    out = r.json()
    keys = {f["key"] for f in out["diagnosis"]["findings"]}
    assert "shorts" in keys and "tight_stops" in keys
    w = out["diagnosis"]["worst_period"]
    assert w["depth_pct"] < 0 and w["from"] and w["market"] in ("up", "down", "range")
    titles = [f["title"] for f in out["fixes"]]
    assert "Long trades only" in titles and any(t.startswith("Wider stop") for t in titles)
    for f in out["fixes"]:
        assert set(f["stats"]) >= {"cagr_pct", "max_drawdown_pct", "trades"} and isinstance(f["better"], bool)
        agent.AgentConfig(**f["config"])  # every fix is a valid setup the agent could run
    long_only = next(f for f in out["fixes"] if f["title"] == "Long trades only")
    assert long_only["config"]["direction"] == "long_only"
    wider = next(f for f in out["fixes"] if f["title"].startswith("Wider stop"))
    # Same money at risk per stop-out: size shrinks as the stop widens.
    assert math.isclose(wider["config"]["size_pct"] * wider["config"]["stop_loss_pct"], 100 * 0.5, rel_tol=1e-6)
    # The coach can read the latest test.
    with db.conn() as c:
        assert c.execute("SELECT result FROM agent_analyses").fetchone()["result"]["diagnosis"]["findings"]


def test_past_test_validation(client):
    signup(client)
    assert client.post("/agent/past", json={"strategy": "buy_and_hold"}).status_code == 422
    assert client.post("/agent/past", json={"strategy": "ma_cross", "params": {"fast": 50, "slow": 10}}).status_code == 422
    assert client.post("/agent/past", json={"strategy": "ma_cross"}).status_code == 422  # no prices yet


def test_live_agent_trades_the_paper_account(client):
    signup(client)
    up = [2000 + i * 2 for i in range(80)]
    end = hourly(up)
    cfg = {"strategy": "ma_cross", "params": {"fast": 5, "slow": 20, "ema": 0}, "tf": "1h", "stop_loss_pct": 2, "size_pct": 50}
    r = client.post("/agent/start", json=cfg)
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["agent"]["status"] == "running" and s["agent"]["signal"] == 1
    paper = client.get("/paper").json()
    pos = paper["positions"]
    assert len(pos) == 1 and pos[0]["side"] == "long" and pos[0]["order_kind"] == "agent"
    assert math.isclose(pos[0]["units"], round(10_000 * 0.5 / (up[-1] + 0.3), 2))
    assert pos[0]["stop_loss"] == round((up[-1] + 0.3) * 0.98, 2)
    assert any(e["kind"] == "open" and "turned long" in e["message"] for e in s["log"])
    assert client.post("/agent/start", json=cfg).status_code == 409

    # Nothing new until the next candle closes.
    assert agent.step(1) is False

    # Prices fall: the next closed candles flip the signal, so it closes the long and goes short.
    down = [up[-1] - i for i in range(1, 31)]  # gentle enough not to reach the 2% stop
    hourly(up + down, end + timedelta(hours=30))
    assert agent.step(1, end + timedelta(hours=30)) is True
    paper = client.get("/paper").json()
    assert [p["side"] for p in paper["positions"]] == ["short"]
    closed = paper["history"][0]
    assert closed["side"] == "long" and closed["close_reason"] == "agent"

    s = client.get("/agent").json()
    assert s["live"]["stats"]["trades"] == 1 and s["live"]["diagnosis"]["findings"]

    r = client.post("/agent/stop", json={"close_position": True}).json()
    assert r["agent"]["status"] == "stopped" and "closed its short position" in r["log"][0]["message"]
    assert client.get("/paper").json()["positions"] == []
    assert client.post("/agent/stop", json={}).status_code == 404


def test_agent_waits_after_a_stop_out(client):
    signup(client)
    up = [2000 + i * 2 for i in range(80)]
    end = hourly(up)
    client.post("/agent/start", json={"strategy": "ma_cross", "params": {"fast": 5, "slow": 20, "ema": 0}, "tf": "1h",
                                      "stop_loss_pct": 0.5, "size_pct": 50})
    # A sharp dip hits the stop, but the trend (and the signal) stays up.
    dip = [up[-1] - 15, up[-1] + 4]
    hourly(up + dip, end + timedelta(hours=2))
    agent.step(1, end + timedelta(hours=2))
    paper = client.get("/paper").json()
    assert paper["positions"] == [] and paper["history"][0]["close_reason"] == "stop_loss"
    s = client.get("/agent").json()
    assert s["agent"]["blocked"] == 1 and any("stop loss" in e["message"] for e in s["log"])


def test_coach_and_assistant_tools(client):
    signup(client)
    assert client.post("/agent/coach", json={"situation": "What if the Fed cuts rates?"}).status_code == 503
    assert assistant.t_my_agent({}, 1)["agent"] is None
    daily([1800 + i for i in range(400)])
    out = assistant.t_diagnose_strategy({"strategy": "rsi_reversion", "years": 1}, 1)
    assert {"diagnosis", "fixes", "stats"} <= set(out)
    content, is_error = assistant.call_tool("diagnose_strategy", {"strategy": "rsi_reversion", "years": 25, "tf": "1h"}, 1)
    assert is_error and "Not enough price history" in content
    names = {t["name"] for t in assistant.TOOLS}
    assert {"my_agent", "diagnose_strategy"} <= names and set(assistant.HANDLERS) == names


def test_agent_needs_login(client):
    assert client.get("/agent").status_code == 401
