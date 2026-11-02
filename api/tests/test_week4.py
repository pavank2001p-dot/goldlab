import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app import assistant, config, fit, ingest
from app.risk import QUESTIONS

UTC = timezone.utc


def signup(client, email="t@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def take_quiz(client, value):
    r = client.post("/risk/profile", json={"answers": {q["key"]: value for q in QUESTIONS}})
    assert r.status_code == 200
    return r.json()["profile"]


def trade(pnl, units=1.0, price=2000.0, stop=None, t=0):
    return {"side": "long", "units": units, "entry_price": price, "entry_time": t, "exit_time": t + 3600,
            "pnl": pnl, "stop_loss": stop}


# ---------------------------------------------------------------------------
# Profile fit
# ---------------------------------------------------------------------------


def test_fit_within_limits():
    # 1 oz at $2000 on $10k = 0.2x; stop $10 away = 0.1% risk; 5% drawdown.
    out = fit.assess([trade(-10, stop=1990), trade(30, stop=1990)], {"max_drawdown_pct": -5}, 10_000, "conservative")
    assert out["verdict"] == "fits"
    assert [c["level"] for c in out["checks"]] == ["fits", "fits", "fits"]
    assert out["suggested_units"] is None and out["notes"] == []


def test_fit_over_limits_suggests_smaller_size():
    # 20 oz at $2000 on $10k = 4x leverage (conservative max 2x); no stop, so the
    # largest loss (3% of equity) stands in for risk per trade.
    out = fit.assess([trade(-300, units=20)], {"max_drawdown_pct": -12}, 10_000, "conservative")
    levels = {c["key"]: c["level"] for c in out["checks"]}
    assert levels == {"drawdown": "close", "risk_per_trade": "over", "leverage": "over"}
    assert out["verdict"] == "over"
    assert "no stop loss" in out["notes"][0]
    # Tightest ratio is risk: 0.5 / 3 -> 20 oz * 0.1667 = 3.3 oz.
    assert out["suggested_units"] == pytest.approx(3.3)


def test_fit_backtest_stop_pct_sets_planned_risk():
    # 5 oz at $2000 with a 1% stop risks $100 = 1% of $10k: fits moderate exactly.
    out = fit.assess([trade(50, units=5)], {"max_drawdown_pct": -3}, 10_000, "moderate", stop_loss_pct=1)
    risk = next(c for c in out["checks"] if c["key"] == "risk_per_trade")
    assert risk["value"] == 1.0 and risk["level"] == "fits"


def test_fit_wiped_out_is_over():
    out = fit.assess([trade(-10_000, units=1)], {"max_drawdown_pct": -100, "wiped_out": True}, 10_000, "aggressive")
    assert out["verdict"] == "over"


def test_fit_endpoints(client):
    signup(client)
    assert client.get("/fit/trades").status_code == 404  # no quiz yet
    take_quiz(client, 0)
    client.post("/trades", json={"side": "long", "units": 50, "open_time": "2024-03-01T10:00:00Z", "open_price": 2000,
                                 "close_time": "2024-03-02T10:00:00Z", "close_price": 1990, "stop_loss": 1980})
    r = client.get("/fit/trades?capital=10000")
    assert r.status_code == 200
    body = r.json()
    assert body["profile"] == "conservative" and body["verdict"] == "over"
    assert body["suggested_units"] < 50

    ingest.load("sample", datetime(2023, 1, 1, tzinfo=UTC), datetime(2024, 1, 1, tzinfo=UTC))
    bt = client.post("/backtests", json={"strategy": "ma_cross", "start": "2023-01-01", "units": 1, "stop_loss_pct": 2}).json()
    r = client.get(f"/fit/backtests/{bt['id']}")
    assert r.status_code == 200 and r.json()["trades_checked"] == bt["stats"]["trades"]
    assert client.get("/fit/backtests/999999").status_code == 404


# ---------------------------------------------------------------------------
# Assistant
# ---------------------------------------------------------------------------


def block(**kw):
    return SimpleNamespace(**kw)


class ScriptedClient:
    """Plays back a fixed list of responses and records each request."""

    def __init__(self, responses):
        self.calls, self.responses = [], list(responses)
        outer = self

        class Messages:
            def create(self, **kw):
                outer.calls.append({**kw, "messages": list(kw["messages"])})
                return outer.responses.pop(0)

        self.beta = SimpleNamespace(messages=Messages())


def test_answer_runs_tools_and_returns_text(client):
    ingest.load("sample", datetime(2024, 1, 1, tzinfo=UTC), datetime(2024, 3, 1, tzinfo=UTC))
    fake = ScriptedClient([
        SimpleNamespace(stop_reason="tool_use", content=[
            block(type="tool_use", id="t1", name="price_summary", input={}),
            block(type="tool_use", id="t2", name="run_backtest", input={"strategy": "nope"}),
        ]),
        SimpleNamespace(stop_reason="end_turn", content=[block(type="text", text="Gold is demo data here.")]),
    ])
    text, used = assistant.answer(fake, 1, "What's gold doing?", [])
    assert text == "Gold is demo data here."
    assert used == ["price_summary", "run_backtest"]
    results = fake.calls[1]["messages"][-1]["content"]
    summary = json.loads(results[0]["content"])
    assert summary["data_source"] == "sample" and summary["price"] > 0
    assert results[1]["is_error"] is True  # bad strategy goes back to the model to fix
    assert fake.calls[0]["tools"] == assistant.TOOLS and fake.calls[0]["fallbacks"] == "default"


def test_tools_handle_missing_data(client):
    assert "error" in json.loads(assistant.call_tool("price_summary", {}, 1)[0])
    assert "error" in json.loads(assistant.call_tool("my_risk_profile", {}, 1)[0])
    assert "error" in json.loads(assistant.call_tool("profile_fit", {}, 1)[0])
    assert assistant.call_tool("nope", {}, 1)[1] is True


def test_ask_flow_and_daily_limit(client, monkeypatch):
    signup(client)
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "")
    assert client.post("/assistant/questions", json={"question": "hi"}).status_code == 503

    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(config, "ASSISTANT_DAILY_LIMIT", 2)
    monkeypatch.setattr(assistant, "answer", lambda c, u, q, h: (f"Answer to {q}", ["price_summary"]))

    r = client.post("/assistant/questions", json={"question": "first"})
    assert r.status_code == 202
    got = client.get(f"/assistant/questions/{r.json()['id']}").json()  # background task already ran
    assert got["status"] == "done" and got["answer"] == "Answer to first" and got["tools_used"] == ["price_summary"]

    history = [{"role": "user", "content": "first"}, {"role": "assistant", "content": "Answer to first"}]
    assert client.post("/assistant/questions", json={"question": "second", "history": history}).status_code == 202
    assert client.get("/assistant/status").json()["remaining"] == 0
    r = client.post("/assistant/questions", json={"question": "third"})
    assert r.status_code == 429 and "midnight UTC" in r.json()["detail"]


def test_failed_answers_do_not_count(client, monkeypatch):
    signup(client)
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(config, "ASSISTANT_DAILY_LIMIT", 1)

    def boom(*a):
        raise RuntimeError("down")

    monkeypatch.setattr(assistant, "answer", boom)
    qid = client.post("/assistant/questions", json={"question": "q"}).json()["id"]
    assert client.get(f"/assistant/questions/{qid}").json()["status"] == "error"
    assert client.get("/assistant/status").json()["remaining"] == 1


def test_history_must_alternate(client):
    signup(client)
    bad = [{"role": "assistant", "content": "hi"}, {"role": "user", "content": "x"}]
    assert client.post("/assistant/questions", json={"question": "q", "history": bad}).status_code == 422


def test_other_users_cannot_read_answers(client, monkeypatch):
    signup(client, "a@example.com")
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(assistant, "answer", lambda c, u, q, h: ("secret", []))
    qid = client.post("/assistant/questions", json={"question": "q"}).json()["id"]
    client.post("/auth/logout")
    signup(client, "b@example.com")
    assert client.get(f"/assistant/questions/{qid}").status_code == 404
