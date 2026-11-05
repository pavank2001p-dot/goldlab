from datetime import date, datetime, timedelta, timezone

import pytest

from app import backtest as bt
from app import ingest

UTC = timezone.utc
T0 = int(datetime(2024, 1, 8, 14, tzinfo=UTC).timestamp())  # a Monday afternoon


def bars_from(closes, step=3600, start=T0):
    """Bars whose open equals the previous close, with a small range around each."""
    out, prev = [], closes[0]
    for i, c in enumerate(closes):
        out.append({"t": start + i * step, "o": prev, "h": max(prev, c) + 0.5, "l": min(prev, c) - 0.5, "c": c})
        prev = c
    return out


def cfg(**kw):
    base = dict(strategy="ma_cross", params={"fast": 2, "slow": 5}, tf="1h", direction="long_only",
                capital=10_000, units=1, spread=0.0, swap_long=0, swap_short=0)
    base.update(kw)
    return bt.BacktestIn(**base)


def test_signal_fills_next_open_and_spread_is_charged():
    bars = bars_from([100] * 5 + [101, 102, 103, 104, 103, 101, 99, 98])
    rep = bt.run(cfg(spread=0.5), bars)
    t = rep["trades"][0]
    # fast > slow first at bar 5's close (101), so the buy fills at bar 6's open (101) plus spread.
    assert t["entry_time"] == bars[6]["t"] and t["entry_price"] == 101.5
    assert t["side"] == "long" and t["costs"] == 0.5
    assert rep["stats"]["trades"] == len(rep["trades"])
    assert rep["stats"]["final_equity"] == pytest.approx(10_000 + sum(x["pnl"] for x in rep["trades"]))


def test_short_and_long_both_directions():
    closes = [100] * 5 + [101, 102, 103, 104, 103, 101, 99, 97, 95, 94]
    rep = bt.run(cfg(direction="both"), bars_from(closes))
    sides = [t["side"] for t in rep["trades"]]
    assert sides[:2] == ["long", "short"]
    assert rep["trades"][-1]["exit_reason"] == "end_of_test"
    assert rep["trades"][1]["pnl"] > 0  # price fell while short


def test_stop_loss_exits_at_stop_and_waits_for_new_signal():
    closes = [100] * 5 + [101, 102, 103] + [103] * 3
    bars = bars_from(closes)
    bars[7] = {"t": bars[7]["t"], "o": 102, "h": 103.2, "l": 90, "c": 103}  # deep wick through the stop
    rep = bt.run(cfg(stop_loss_pct=5), bars)
    t = rep["trades"][0]
    assert t["exit_reason"] == "stop_loss"
    assert t["exit_price"] == pytest.approx(t["entry_price"] * 0.95, abs=1e-3)
    assert len(rep["trades"]) == 1  # no immediate re-entry while the signal is unchanged


def test_swap_charged_per_night_including_weekend():
    # Daily bars Thu..Tue; holding long from Fri open to Tue covers Fri->Mon (3 nights) + Mon->Tue.
    start = int(datetime(2024, 1, 4, 22, tzinfo=UTC).timestamp())  # Thu 17:00 NY -> trading day Fri
    days = [start + d * 86400 for d in (0, 1, 4, 5)]
    bars = [{"t": t, "o": 100, "h": 100, "l": 100, "c": 100} for t in days]
    one = bt.BacktestIn(strategy="ma_cross", params={"fast": 2, "slow": 5}, tf="1d", direction="long_only",
                        units=2, spread=0, swap_long=-0.5)
    sig = [1, 1, 1, 1]
    orig = bt.signals
    bt.signals = lambda *a: sig
    try:
        rep = bt.run(one, bars)
    finally:
        bt.signals = orig
    # Enters at bar 1 open; nights from bar1->bar2 (3) and bar2->bar3 (1) = 4 nights x 2 oz x -0.5.
    assert rep["trades"][0]["swap"] == -4.0


def test_account_wipe_out_stops_the_test():
    closes = [100] * 5 + [101, 102, 103, 50, 40, 30]
    rep = bt.run(cfg(units=1000), bars_from(closes))
    assert rep["stats"]["wiped_out"] is True
    assert rep["trades"][-1]["exit_reason"] == "account_wiped_out"


@pytest.mark.parametrize("strategy", list(bt.STRATEGIES))
def test_every_strategy_runs_on_sample_data(client, strategy):
    ingest.backfill("sample", date(2023, 1, 1))
    client.post("/auth/signup", json={"email": "bt@example.com", "password": "longenough"})
    r = client.post("/backtests", json={"strategy": strategy, "tf": "1d", "start": "2023-01-01"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["stats"]["trades"] > 0 and body["equity"]
    saved = client.get(f"/backtests/{body['id']}").json()
    assert saved["stats"] == body["stats"]
    assert client.get("/backtests").json()[0]["id"] == body["id"]


def test_validation_and_auth(client):
    assert client.post("/backtests", json={"strategy": "ma_cross"}).status_code == 401
    client.post("/auth/signup", json={"email": "v@example.com", "password": "longenough"})
    bad = client.post("/backtests", json={"strategy": "ma_cross", "params": {"fast": 50, "slow": 20}})
    assert bad.status_code == 422 and "shorter" in bad.text
    assert client.post("/backtests", json={"strategy": "ma_cross", "params": {"bogus": 1}}).status_code == 422
    assert len(client.get("/backtests/strategies").json()) == len(bt.STRATEGIES)


def test_other_users_cannot_read_backtests(client):
    ingest.backfill("sample", date(2024, 1, 1))
    client.post("/auth/signup", json={"email": "a1@example.com", "password": "longenough"})
    bid = client.post("/backtests", json={"strategy": "breakout", "start": "2024-01-01"}).json()["id"]
    client.cookies.clear()
    client.post("/auth/signup", json={"email": "a2@example.com", "password": "longenough"})
    assert client.get(f"/backtests/{bid}").status_code == 404


def random_bars(n=400, seed=3):
    import random

    rng, p, out = random.Random(seed), 2000.0, []
    for i in range(n):
        o = p
        p *= 1 + rng.gauss(0, 0.01)
        out.append({"t": T0 + i * 86400, "o": o, "h": max(o, p) * 1.003, "l": min(o, p) * 0.997, "c": p})
    return out


@pytest.mark.parametrize("key", list(bt.STRATEGIES))
def test_every_strategy_runs_without_looking_ahead(key):
    bars = random_bars()
    params = bt.BacktestIn(strategy=key).params
    full = bt.signals(key, params, bars)
    assert len(full) == len(bars) and set(full) <= {-1, 0, 1}
    # A signal at bar i must not change when later bars are added.
    for cut in (60, 150, 300):
        assert bt.signals(key, params, bars[:cut]) == full[:cut], key
    rep = bt.run(bt.BacktestIn(strategy=key, tf="1d", units=1), bars)
    assert rep["stats"]["trades"] >= 1, key


def test_strategy_list_and_validation():
    keys = [s["key"] for s in bt.strategies()]
    assert len(keys) == len(set(keys)) >= 15
    assert all(s["kind_label"] for s in bt.strategies())
    with pytest.raises(ValueError, match="fast average"):
        bt.BacktestIn(strategy="macd", params={"fast": 30, "slow": 20})
    with pytest.raises(ValueError, match="oversold"):
        bt.BacktestIn(strategy="stochastic", params={"lower": 50, "upper": 50})


def test_buy_and_hold_matches_the_market():
    bars = random_bars(200)
    rep = bt.run(bt.BacktestIn(strategy="buy_and_hold", tf="1d", units=1, swap_long=0, spread=0), bars)
    t = rep["trades"][0]
    assert len(rep["trades"]) == 1 and t["entry_time"] == bars[1]["t"] and t["exit_reason"] == "end_of_test"
    assert t["pnl"] == pytest.approx(bars[-1]["c"] - bars[1]["o"], abs=0.01)
