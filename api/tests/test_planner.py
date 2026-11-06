import math
import random
from datetime import datetime, timedelta, timezone

from app import backtest as bt
from app import fit, ingest, planner
from app.risk import QUESTIONS

UTC = timezone.utc


def signup(client, email="s@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def quiz(client, value, **overrides):
    answers = {q["key"]: value for q in QUESTIONS} | overrides
    assert client.post("/risk/profile", json={"answers": answers}).status_code == 200


def daily_bars(years=3.5, seed=7):
    """A trending random walk of daily bars ending today."""
    rnd, price, bars = random.Random(seed), 1500.0, []
    days = int(years * 365)
    start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days)
    for i in range(days):
        d = start + timedelta(days=i)
        if d.weekday() >= 5:
            continue
        o = price
        price *= math.exp(rnd.gauss(0.0004, 0.01) + 0.02 * math.sin(i / 60) / 60)
        h, l = max(o, price) * (1 + abs(rnd.gauss(0, 0.003))), min(o, price) * (1 - abs(rnd.gauss(0, 0.003)))
        bars.append(ingest.Bar(d, o, h, l, price))
    ingest.upsert(bars, "1d")


def test_size_pct_sizes_each_trade_from_the_account():
    closes = [100, 100, 110, 121, 121, 100, 100, 110, 121, 121]
    bars = [{"t": i * 86400, "o": c, "h": c, "l": c, "c": c} for i, c in enumerate(closes)]
    cfg = bt.BacktestIn(strategy="buy_and_hold", tf="1d", capital=10_000, size_pct=200, spread=0, swap_long=0)
    rep = bt.run(cfg, bars)
    t = rep["trades"][0]
    assert math.isclose(t["units"], 10_000 * 2 / 100)  # 2x the account at the first fill
    assert math.isclose(rep["stats"]["final_equity"], 10_000 + 200 * 21)


def test_fit_rounding_does_not_flip_verdict():
    assert fit._level(1.0000001, 1.0) == "fits" and fit._level(1.2, 1.0) == "close"


def test_finder_needs_a_profile_and_valid_period(client):
    signup(client)
    assert client.post("/plans/match", json={}).status_code == 404
    assert client.post("/plans/match", json={"profile": "moderate", "years": 7}).status_code == 422
    assert client.post("/plans/match", json={"profile": "moderate", "tf": "1h", "years": 5}).status_code == 422
    assert client.post("/plans/match", json={"profile": "moderate", "years": 3}).status_code == 422  # no prices


def test_options_follow_the_quiz(client):
    signup(client)
    assert client.get("/plans/options").json()["defaults"]["profile"] is None
    quiz(client, 3)  # aggressive, holds minutes to hours, high leverage is fine
    d = client.get("/plans/options").json()["defaults"]
    assert d == {"profile": "aggressive", "tf": "1h", "max_leverage": 10, "complete": True}
    quiz(client, 1, leverage=0)
    d = client.get("/plans/options").json()["defaults"]
    assert d["profile"] == "conservative" and d["tf"] == "1d" and d["max_leverage"] == 1


def test_finder_results_stay_inside_the_profile(client):
    signup(client)
    quiz(client, 1)  # conservative
    daily_bars()
    planner._cache.clear()
    r = client.post("/plans/match", json={"years": 3, "capital": 25_000})
    assert r.status_code == 200, r.text
    out = r.json()
    limits = out["limits"]
    assert out["profile"] == "conservative" and limits["max_drawdown_pct"] == 10
    ins, oos = out["periods"]["in_sample"], out["periods"]["out_of_sample"]
    assert ins["end"] < oos["start"]  # the check period comes after the tuning period
    n = len(bt.STRATEGIES) - 1  # every strategy but buy and hold
    assert len(out["results"]) == n and out["tried"] > n
    assert {r["strategy"] for r in out["results"]} == set(bt.STRATEGIES) - {"buy_and_hold"}

    for res in out["results"]:
        # Sized so a stop-out costs at most the per-trade limit, within the leverage cap.
        assert res["size_pct"] * res["stop_loss_pct"] / 100 <= limits["max_risk_per_trade_pct"] * 1.001
        assert res["size_pct"] <= limits["max_leverage"] * 100
        if res["qualifies"]:
            s = res["in_sample"]
            assert res["in_sample_fit"] == "fits" and s["cagr_pct"] > 0 and s["trades"] >= planner.MIN_TRADES
            assert abs(s["max_drawdown_pct"]) <= limits["max_drawdown_pct"]
    scores = [r["score"] for r in out["results"] if r["qualifies"]]
    assert scores == sorted(scores, reverse=True)
    assert out["benchmark"]["size_pct"] == 100

    # The user's own choices narrow the search, and results are reused for the same question.
    trend = client.post("/plans/match", json={"years": 3, "style": "trend", "max_leverage": 0.5}).json()
    assert {r["kind"] for r in trend["results"]} == {"trend"} and trend["max_leverage"] == 0.5
    assert all(r["size_pct"] <= 50 for r in trend["results"])
    assert client.post("/plans/match", json={"years": 3, "max_leverage": 50}).json()["max_leverage"] == 2
    n = len(planner._cache)
    client.post("/plans/match", json={"years": 3, "capital": 1_000})
    assert len(planner._cache) == n


def test_finder_needs_login(client):
    assert client.post("/plans/match", json={"profile": "moderate"}).status_code == 401
