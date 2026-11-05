import math
from datetime import date, datetime, timezone

import pytest

from app import ingest, scenarios as sc

UTC = timezone.utc


def flat_moves(n=500, up=0.01):
    """Alternating +up / -up days, each reaching half a step beyond its close."""
    out = []
    for i in range(n):
        r = up if i % 2 == 0 else -up
        out.append((r, max(r, 0) + up / 2, min(r, 0) - up / 2))
    return out


def test_trading_days_skip_weekends():
    days = sc.trading_days(date(2026, 11, 6), 7)  # a Friday
    assert days[0] == date(2026, 11, 9) and all(d.weekday() < 5 for d in days) and len(days) == 5


def test_bands_are_ordered_and_centred_without_trend():
    cfg = sc.ScenarioIn(entry=2000, horizon_days=91)
    out = sc.simulate(cfg, flat_moves(), date(2026, 1, 5), paths=800, seed=1)
    for b in out["bands"]:
        assert b["p5"] <= b["p25"] <= b["p50"] <= b["p75"] <= b["p95"]
    last = out["bands"][-1]
    assert last["p5"] < 2000 < last["p95"]
    assert abs(last["p50"] / 2000 - 1) < 0.03  # no direction taken
    assert [c["label"] for c in out["checkpoints"]] == ["1 week", "1 month", "3 months"]
    assert out["outcomes"] == {"target": 0.0, "stop": 0.0, "open": 100.0}
    assert sum(h["count"] for h in out["pnl"]["histogram"]) == 800


def test_trend_is_removed_unless_asked():
    up = [(0.002 + r, h + 0.002, l + 0.002) for r, h, l in flat_moves()]
    base = sc.ScenarioIn(entry=2000, horizon_days=182)
    plain = sc.simulate(base, up, date(2026, 1, 5), paths=500, seed=2)["bands"][-1]["p50"]
    trend = sc.simulate(base.model_copy(update={"with_trend": True}), up, date(2026, 1, 5), paths=500, seed=2)
    assert abs(plain / 2000 - 1) < 0.03 and trend["bands"][-1]["p50"] > 2000 * 1.2


def test_stops_and_targets():
    cfg = sc.ScenarioIn(entry=2000, units=2, stop=1985, target=2015, horizon_days=60, spread=0, swap_long=0)
    out = sc.simulate(cfg, flat_moves(up=0.02), date(2026, 1, 5), paths=400, seed=3)
    # Every day reaches at least 1% either side, so a 0.75% stop and target both trigger on day one,
    # and the stop is assumed to come first.
    assert out["outcomes"]["stop"] == 100.0 and out["median_days_held"] == 1
    assert out["pnl"]["p50"] == pytest.approx(-30) and out["loss_at_stop"] == 30
    wide = cfg.model_copy(update={"stop": 1000})  # only the target is reachable
    assert sc.simulate(wide, flat_moves(up=0.02), date(2026, 1, 5), paths=100)["outcomes"]["target"] == 100.0
    short = sc.ScenarioIn(side="short", entry=2000, units=1, stop=2050, target=1500, horizon_days=10, spread=0.5)
    assert sc.simulate(short, flat_moves(up=0.001), date(2026, 1, 5), paths=50)["loss_at_stop"] == 50


def test_validation():
    with pytest.raises(ValueError, match="stop must be below"):
        sc.ScenarioIn(entry=2000, stop=2100)
    with pytest.raises(ValueError, match="target must be below"):
        sc.ScenarioIn(side="short", entry=2000, target=2100)
    with pytest.raises(ValueError, match="60 days"):
        sc.simulate(sc.ScenarioIn(entry=2000), flat_moves(10), date(2026, 1, 5))


def test_endpoint(client):
    assert client.post("/scenarios", json={}).status_code == 401
    client.post("/auth/signup", json={"email": "s@example.com", "password": "longenough"})
    ingest.load("sample", datetime(2023, 1, 1, tzinfo=UTC), datetime(2024, 6, 1, tzinfo=UTC))
    r = client.post("/scenarios", json={"horizon_days": 30, "stop": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["entry"] > 0 and body["recent"] and body["history"]["days"] > 100
    assert math.isclose(sum(body["outcomes"].values()), 100, abs_tol=0.2)
    # A stop above the latest price is caught after the entry is filled in.
    bad = client.post("/scenarios", json={"stop": body["entry"] * 2})
    assert bad.status_code == 422 and "below the entry" in bad.json()["detail"]
    # Same inputs, same result.
    assert client.post("/scenarios", json={"horizon_days": 30, "stop": 1}).json()["pnl"] == body["pnl"]
