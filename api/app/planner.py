"""Strategy finder: tries each backtest strategy with a few settings, sizes every trade to the
user's risk profile, and ranks what stayed inside the profile's limits.

To be honest about curve fitting, settings are chosen on the first 70% of the period and then
re-run, unchanged, on the last 30%, which the choice never saw. Everything here describes past
results on real prices. It is education, not a recommendation to trade."""

import time
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from . import config
from .auth import UserOut, current_user
from .backtest import KINDS, STRATEGIES, BacktestIn, load_bars, run
from .fit import assess
from .risk import PROFILES, profile_of

router = APIRouter(prefix="/plans", tags=["plans"])

IN_SAMPLE = 0.7
# Stop distances to try (% of entry price) on daily candles; hourly candles use half.
STOPS = {"conservative": (1, 2, 4), "moderate": (1.5, 3, 5), "aggressive": (2, 4, 8)}
# Settings that are lengths in bars, which the faster and slower variants halve and double.
LENGTHS = {"fast", "slow", "signal", "period", "entry", "exit", "lookback", "atr", "smooth"}
YEARS = {"1d": (3, 5, 10, 20), "1h": (1, 2)}
MIN_TRADES = 5
BASE_CAPITAL = 100_000.0  # trades are sized as a share of the account, so results don't depend on it
# Quiz answers that set the defaults: how long trades are held, and how much leverage feels fine.
HORIZON_TF = ["1d", "1d", "1d", "1h"]
LEVERAGE_CAP = [1, 2, 5, 10]

_cache: dict[tuple, tuple[float, dict]] = {}
CACHE_SECONDS = 6 * 3600


class PlanIn(BaseModel):
    profile: Literal["conservative", "moderate", "aggressive"] | None = None
    tf: Literal["1d", "1h"] = "1d"
    years: int = 10
    style: Literal["any", "trend", "reversion"] = "any"
    direction: Literal["both", "long_only"] = "both"
    capital: float = Field(10_000, gt=0, le=100_000_000)
    max_leverage: float | None = Field(None, gt=0, le=1000)


def _variants(key: str) -> list[dict]:
    spec = STRATEGIES[key]["params"]
    base = {p["key"]: p["default"] for p in spec}
    out = [base]
    for f in (0.5, 2):
        v = dict(base)
        for p in spec:
            if p["key"] in LENGTHS:
                v[p["key"]] = min(max(round(p["default"] * f), p["min"]), p["max"])
        if v not in out:
            out.append(v)
    return out


def _cfg(key: str, params: dict, tf: str, direction: str, size_pct: float, stop: float | None) -> BacktestIn | None:
    try:
        return BacktestIn(strategy=key, params=params, tf=tf, start=date(2000, 1, 1), direction=direction,
                          capital=BASE_CAPITAL, size_pct=size_pct, stop_loss_pct=stop)
    except ValidationError:
        return None


def _summary(rep: dict) -> dict:
    s = rep["stats"]
    return {k: s.get(k) for k in ("total_return_pct", "cagr_pct", "max_drawdown_pct", "sharpe", "trades",
                                  "win_rate_pct", "profit_factor", "buy_and_hold_pct", "time_in_market_pct", "wiped_out")}


def _calmar(s: dict) -> float:
    cagr, dd = s.get("cagr_pct"), abs(s.get("max_drawdown_pct") or 0)
    if cagr is None:
        return float("-inf")
    return cagr / max(dd, 1.0)


def _sized_run(cfg: BacktestIn, bars: list[dict], profile: str) -> tuple[BacktestIn, dict, dict]:
    """Run, and if the result breaks a profile limit, shrink the trade size to fit and run again.
    Drawdown, leverage and per-trade risk all scale with size, so one resize is enough."""
    rep = run(cfg, bars)
    fit = assess(rep["trades"], rep["stats"], BASE_CAPITAL, profile, cfg.stop_loss_pct)
    if fit["verdict"] != "fits":
        ratios = [c["limit"] / c["value"] for c in fit["checks"] if c["value"]]
        if ratios and min(ratios) < 1:
            cfg = cfg.model_copy(update={"size_pct": cfg.size_pct * min(ratios) * 0.95})
            rep = run(cfg, bars)
            fit = assess(rep["trades"], rep["stats"], BASE_CAPITAL, profile, cfg.stop_loss_pct)
    return cfg, rep, fit


def _search(profile: str, tf: str, years: int, style: str, direction: str, max_lev: float) -> dict:
    limits = PROFILES[profile]
    start = date.today() - timedelta(days=round(years * 365.25))
    bars = load_bars(tf, start, None)
    if len(bars) < 300:
        raise HTTPException(422, "Not enough price history for that period yet")
    cut = int(len(bars) * IN_SAMPLE)
    ins, outs = bars[:cut], bars[cut:]
    stops = [s / 2 if tf == "1h" else s for s in STOPS[profile]]

    def size_for(stop: float) -> float:
        # Risk the profile's share of the account if the stop is hit, within the leverage cap.
        return min(limits["max_risk_per_trade_pct"] / stop, max_lev) * 100

    best: dict[str, dict] = {}
    for key, spec in STRATEGIES.items():
        if spec["kind"] == "benchmark" or (style != "any" and spec["kind"] != style):
            continue
        for params in _variants(key):
            for stop in stops:
                cfg = _cfg(key, params, tf, direction, size_for(stop), stop)
                if cfg is None:
                    continue
                cfg, rep, fit = _sized_run(cfg, ins, profile)
                s = _summary(rep)
                ok = fit["verdict"] == "fits" and (s["trades"] or 0) >= MIN_TRADES and (s["cagr_pct"] or 0) > 0
                score = _calmar(s) if ok else float("-inf")
                cur = best.get(key)
                if cur is None or score > cur["score"] or (score == cur["score"] == float("-inf") and _calmar(s) > _calmar(cur["in_sample"])):
                    best[key] = {"cfg": cfg, "in_sample": s, "in_fit": fit, "score": score}

    results = []
    for key, b in best.items():
        cfg = b["cfg"]
        oos = run(cfg, outs)
        oos_fit = assess(oos["trades"], oos["stats"], BASE_CAPITAL, profile, cfg.stop_loss_pct)
        results.append({
            "strategy": key,
            "label": STRATEGIES[key]["label"],
            "kind": STRATEGIES[key]["kind"],
            "kind_label": KINDS[STRATEGIES[key]["kind"]],
            "summary": STRATEGIES[key]["summary"],
            "params": cfg.params,
            "param_labels": {p["key"]: p["label"] for p in STRATEGIES[key]["params"]},
            "stop_loss_pct": cfg.stop_loss_pct,
            "size_pct": round(cfg.size_pct, 2),
            "in_sample": b["in_sample"],
            "in_sample_fit": b["in_fit"]["verdict"],
            "out_of_sample": _summary(oos),
            "out_of_sample_fit": oos_fit["verdict"],
            "qualifies": b["score"] != float("-inf"),
            "score": None if b["score"] == float("-inf") else round(b["score"], 3),
        })
    results.sort(key=lambda r: (r["qualifies"], r["score"] or 0, _calmar(r["in_sample"])), reverse=True)

    # Simply owning gold with no leverage, as a yardstick.
    hold_cfg = _cfg("buy_and_hold", {}, tf, "long_only", 100, None)
    hold_in, hold_out = run(hold_cfg, ins), run(hold_cfg, outs)
    hold_fit = assess(hold_in["trades"], hold_in["stats"], BASE_CAPITAL, profile)
    hold_out_fit = assess(hold_out["trades"], hold_out["stats"], BASE_CAPITAL, profile)

    return {
        "periods": {
            "in_sample": {"start": ins[0]["t"], "end": ins[-1]["t"]},
            "out_of_sample": {"start": outs[0]["t"], "end": outs[-1]["t"]},
        },
        "results": results,
        "benchmark": {"in_sample": _summary(hold_in), "in_sample_fit": hold_fit["verdict"],
                      "out_of_sample": _summary(hold_out), "out_of_sample_fit": hold_out_fit["verdict"],
                      "size_pct": 100},
        "tried": sum(len(_variants(k)) * len(stops) for k in best),
        "last_price": bars[-1]["c"],
    }


def match(body: PlanIn, user_id: int) -> dict:
    saved = profile_of(user_id)
    profile = body.profile or (saved["profile"] if saved else None)
    if not profile:
        raise HTTPException(404, "Take the risk quiz first, or pick a profile")
    if body.years not in YEARS[body.tf]:
        raise HTTPException(422, f"Choose one of {', '.join(map(str, YEARS[body.tf]))} years for these candles")
    limits = PROFILES[profile]
    max_lev = min(body.max_leverage or limits["max_leverage"], limits["max_leverage"])

    key = (profile, body.tf, body.years, body.style, body.direction, max_lev, date.today())
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        out = hit[1]
    else:
        out = _search(profile, body.tf, body.years, body.style, body.direction, max_lev)
        _cache[key] = (time.time(), out)
        for k in [k for k, (t, _) in _cache.items() if time.time() - t > CACHE_SECONDS]:
            _cache.pop(k, None)

    # Sizes in ounces for the user's own capital, at the price where each test period starts.
    return {
        "profile": profile,
        "profile_label": limits["label"],
        "limits": {k: limits[k] for k in ("max_risk_per_trade_pct", "max_drawdown_pct", "max_leverage")},
        "max_leverage": max_lev,
        "capital": body.capital,
        "tf": body.tf,
        "years": body.years,
        **out,
    }


def defaults(user_id: int) -> dict:
    """Starting choices from the user's quiz answers: their holding period and leverage comfort."""
    saved = profile_of(user_id)
    out = {"profile": None, "tf": "1d", "max_leverage": None, "complete": False}
    if saved:
        a = saved["answers"]
        out["profile"] = saved["profile"]
        out["complete"] = saved["complete"]
        if "horizon" in a:
            out["tf"] = HORIZON_TF[a["horizon"]]
        if "leverage" in a:
            out["max_leverage"] = min(LEVERAGE_CAP[a["leverage"]], PROFILES[saved["profile"]]["max_leverage"])
    return out


@router.get("/options")
def options(user: UserOut = Depends(current_user)):
    return {"profiles": PROFILES, "years": YEARS, "defaults": defaults(user.id),
            "history_since": config.HISTORY_SINCE.isoformat()}


@router.post("/match")
def match_route(body: PlanIn, user: UserOut = Depends(current_user)):
    return match(body, user.id)
