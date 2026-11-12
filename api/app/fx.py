"""Exchange rates for showing gold in a local currency. Trading stays in US dollars.

Rates come from the European Central Bank's daily reference rates through the free Frankfurter
service, cached for six hours. The UAE dirham is pegged to the dollar, so it is fixed. When the
feed can't be reached the last good rates are kept, or rough built-in ones are used and marked.
"""

import logging
import time

import httpx
from fastapi import APIRouter

from . import config

log = logging.getLogger("api.fx")
router = APIRouter(prefix="/fx", tags=["fx"])

# Currencies offered in the picker. AED is pegged at 3.6725 per dollar.
CURRENCIES = ["USD", "INR", "AED", "EUR", "GBP", "SAR", "PKR", "SGD", "MYR", "AUD", "CAD", "JPY", "CNY", "TRY", "ZAR"]
PEGGED = {"USD": 1.0, "AED": 3.6725, "SAR": 3.75}
# Rough rates used only until the first successful fetch; the response says so.
FALLBACK = {"INR": 84.0, "EUR": 0.93, "GBP": 0.79, "PKR": 280.0, "SGD": 1.34, "MYR": 4.45, "AUD": 1.52,
            "CAD": 1.38, "JPY": 150.0, "CNY": 7.2, "TRY": 34.0, "ZAR": 18.0}
TTL = 6 * 3600

_cache: dict = {"at": 0.0, "rates": None, "as_of": None}


def fetch() -> tuple[dict[str, float], str | None]:
    wanted = [c for c in CURRENCIES if c not in PEGGED]
    r = httpx.get(config.FX_URL, params={"base": "USD", "symbols": ",".join(wanted)}, timeout=15,
                  headers={"User-Agent": "goldlab/1.0"})
    r.raise_for_status()
    body = r.json()
    rates = {k: float(v) for k, v in (body.get("rates") or {}).items() if k in wanted and float(v) > 0}
    if not rates:
        raise ValueError("no rates in response")
    return rates, body.get("date")


def rates() -> dict:
    now = time.time()
    if _cache["rates"] is None or now - _cache["at"] > TTL:
        try:
            got, as_of = fetch()
            _cache.update(at=now, rates=got, as_of=as_of)
        except (httpx.HTTPError, ValueError) as e:
            log.warning("fx fetch failed: %s", e)
            # Try again in ten minutes rather than on every request.
            _cache["at"] = now - TTL + 600
    live = _cache["rates"] or {}
    out = {**FALLBACK, **live, **PEGGED}
    return {
        "base": "USD",
        "rates": {c: out[c] for c in CURRENCIES if c in out},
        "as_of": _cache["as_of"],
        "source": "ecb" if live else "fallback",
        "pegged": sorted(PEGGED),
    }


def clear_cache():
    _cache.update(at=0.0, rates=None, as_of=None)


@router.get("")
def get_rates():
    return rates()
