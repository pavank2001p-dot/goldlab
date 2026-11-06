import math
import random
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app import backtest as bt
from app import custom, ingest, planner
from app.custom import Rules

UTC = timezone.utc


def signup(client, email="c@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201


def bars_from(prices: list[float]) -> list[dict]:
    out = []
    for i, p in enumerate(prices):
        prev = prices[i - 1] if i else p
        out.append({"t": 1_600_000_000 + i * 86400, "o": prev, "h": max(prev, p) * 1.003, "l": min(prev, p) * 0.997, "c": p})
    return out


def walk(n=900, seed=1, drift=0.0003) -> list[float]:
    rnd, px, out = random.Random(seed), 1500.0, []
    for _ in range(n):
        px *= math.exp(rnd.gauss(drift, 0.01))
        out.append(px)
    return out


NEW = ["ichimoku", "triple_ma", "heikin_ashi", "aroon", "squeeze", "inside_bar", "rsi2_pullback", "fib_pullback"]


@pytest.mark.parametrize("key", NEW)
def test_new_strategies_trade_both_ways_and_backtest(key):
    bars = bars_from(walk())
    cfg = bt.BacktestIn(strategy=key)
    sig = bt.signals(key, cfg.params, bars)
    assert len(sig) == len(bars) and set(sig) <= {-1, 0, 1}
    assert 1 in sig and -1 in sig, key
    rep = bt.run(cfg, bars)
    assert rep["stats"]["trades"] > 0


def test_trend_strategies_go_long_in_a_steady_rise():
    bars = bars_from([1000 * 1.003 ** i for i in range(400)])
    for key in ("ichimoku", "triple_ma", "heikin_ashi", "aroon"):
        assert bt.signals(key, bt.BacktestIn(strategy=key).params, bars)[-1] == 1, key


def test_new_strategy_settings_are_checked():
    with pytest.raises(ValidationError, match="fast to middle to slow"):
        bt.BacktestIn(strategy="triple_ma", params={"fast": 30, "mid": 20, "slow": 50})
    with pytest.raises(ValidationError, match="conversion to base"):
        bt.BacktestIn(strategy="ichimoku", params={"tenkan": 30, "kijun": 26, "senkou": 52})


def _rules(**kw) -> Rules:
    return Rules(name="Test", **kw)


def cond(left, op, right):
    return {"left": left, "op": op, "right": right}


def test_custom_golden_cross_matches_the_built_in_crossover():
    bars = bars_from(walk(seed=4))
    rules = _rules(
        long_entry=[cond({"ind": "sma", "n": 10}, ">", {"ind": "sma", "n": 30})],
        short_entry=[cond({"ind": "sma", "n": 10}, "<", {"ind": "sma", "n": 30})],
    )
    mine = bt.signals("custom", {}, bars, rules)
    built_in = bt.signals("ma_cross", {"fast": 10, "slow": 30, "ema": 0}, bars)
    assert mine[40:] == built_in[40:]


def test_custom_rules_exits_crosses_and_numbers():
    # Up 30 bars, down 30, up 30: a long that exits when the close falls below the 5-bar average.
    prices = [100 + i for i in range(30)] + [129 - i for i in range(30)] + [100 + i for i in range(30)]
    bars = bars_from(prices)
    rules = _rules(
        long_entry=[cond({"ind": "close"}, "crosses_above", {"ind": "sma", "n": 5}),
                    cond({"ind": "close"}, ">", {"ind": "value", "value": 99.5})],
        long_exit=[cond({"ind": "close"}, "<", {"ind": "sma", "n": 5})],
    )
    sig = custom.signals(rules, bars)
    assert -1 not in sig
    assert sig[25] == 0  # no fresh cross while it just keeps rising
    assert sig[40] == 0  # exited on the fall
    assert 1 in sig[61:]  # re-entered on the second rise


def test_custom_rules_are_validated():
    with pytest.raises(ValidationError, match="at least one condition"):
        Rules(name="Empty")
    with pytest.raises(ValidationError, match="not a number"):
        _rules(long_entry=[cond({"ind": "value", "value": 1}, ">", {"ind": "close"})])
    with pytest.raises(ValidationError, match="Enter a number"):
        _rules(long_entry=[cond({"ind": "close"}, ">", {"ind": "value"})])
    with pytest.raises(ValidationError, match="fast length"):
        _rules(long_entry=[cond({"ind": "macd", "n": 30, "m": 20}, ">", {"ind": "value", "value": 0})])
    with pytest.raises(ValidationError, match="needs its rules"):
        bt.BacktestIn(strategy="custom")
    r = _rules(long_entry=[cond({"ind": "bb_lower"}, "<", {"ind": "close"})])
    assert r.long_entry[0].left.n == 20 and r.long_entry[0].left.m == 2  # defaults filled in
    assert "Bollinger lower band (20, 2)" in custom.describe(r)


def test_every_indicator_computes():
    bars = bars_from(walk(300))
    for key in custom.INDICATORS:
        o = custom.Operand(ind=key, value=1 if key == "value" else None)
        s = custom._series(o, bars, {})
        assert len(s) == len(bars) and s[-1] is not None, key


def daily(prices: list[float]):
    start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=len(prices))
    rows = []
    for i, p in enumerate(prices):
        prev = prices[i - 1] if i else p
        rows.append(ingest.Bar(start + timedelta(days=i), prev, max(prev, p) * 1.004, min(prev, p) * 0.996, p))
    ingest.upsert(rows, "1d")


TEMPLATE = {"name": "Dip buyer", "long_entry": [cond({"ind": "rsi", "n": 14}, "<", {"ind": "value", "value": 40})],
            "long_exit": [cond({"ind": "rsi", "n": 14}, ">", {"ind": "value", "value": 55})]}


def test_save_backtest_and_run_as_agent(client):
    assert client.get("/custom-strategies").status_code == 401
    cat = client.get("/custom-strategies/catalog").json()
    assert len(cat["indicators"]) == len(custom.INDICATORS) and cat["templates"]
    signup(client)
    r = client.post("/custom-strategies", json={"rules": TEMPLATE})
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    assert "Long when RSI (14) is below 40" in r.json()["description"]
    r = client.put(f"/custom-strategies/{sid}", json={"rules": {**TEMPLATE, "name": "Dip buyer 2"}})
    assert r.json()["name"] == "Dip buyer 2"
    assert [s["name"] for s in client.get("/custom-strategies").json()] == ["Dip buyer 2"]

    daily(walk(700, seed=9))
    r = client.post("/custom-strategies/preview", json={"rules": TEMPLATE, "years": 1.5, "stop_loss_pct": 3})
    assert r.status_code == 200, r.text
    pv = r.json()
    assert pv["candles"] and pv["stats"]["trades"] == len(pv["trades"]) > 0 and 0 < pv["in_market_pct"] <= 100
    start = (datetime.now(UTC) - timedelta(days=650)).date().isoformat()
    r = client.post("/backtests", json={"strategy": "custom", "rules": TEMPLATE, "start": start})
    assert r.status_code == 201, r.text
    assert r.json()["stats"]["trades"] > 0

    r = client.post("/agent/past", json={"strategy": "custom", "rules": TEMPLATE, "years": 1.5})
    assert r.status_code == 200, r.text
    assert r.json()["config"]["rules"]["name"] == "Dip buyer"

    r = client.post("/agent/start", json={"strategy": "custom", "rules": TEMPLATE})
    assert r.status_code == 200, r.text
    assert r.json()["agent"]["label"] == "Dip buyer"

    # Another user can't see or change it.
    client.post("/auth/logout")
    signup(client, "other@example.com")
    assert client.get("/custom-strategies").json() == []
    assert client.delete(f"/custom-strategies/{sid}").status_code == 404


@pytest.fixture
def fresh_cache():
    planner._cache.clear()
    yield
    planner._cache.clear()  # results are cached by date, not by data, so don't leak them into other tests


def test_strategy_finder_includes_saved_strategies(client, fresh_cache):
    signup(client)
    client.post("/risk/profile", json={"answers": {}})
    client.post("/custom-strategies", json={"rules": TEMPLATE})
    daily(walk(1200, seed=5))
    r = client.post("/plans/match", json={"profile": "moderate", "tf": "1d", "years": 3})
    assert r.status_code == 200, r.text
    mine = [x for x in r.json()["results"] if x["kind"] == "custom"]
    assert len(mine) == 1 and mine[0]["label"] == "Dip buyer" and mine[0]["rules"]["long_entry"]
    keys = {x["strategy"] for x in r.json()["results"]}
    assert set(NEW) <= keys
