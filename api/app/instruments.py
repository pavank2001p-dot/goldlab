"""The markets Trading Lab can chart, backtest and paper trade.

Every instrument is quoted in US dollars, so profit and loss in the price's units is already in
the account's currency and the backtester and paper account need no currency conversion.

History comes from Dukascopy's free datafeed (the same feed as gold; no key). Their stocks,
indices and commodities are CFDs that track the underlying market. Live quotes come from
Finnhub's websocket when FINNHUB_API_KEY is set (free plan: US stocks, OANDA forex and CFDs,
Binance crypto). Prices are stored as bids, like gold.

Per-class rules:
- trading hours (`hours`): "fx" is Sunday 18:00 to Friday 17:00 New York with a daily 17:00-18:00
  break (forex, metals, energy, index CFDs); "us_stock" is 09:30-16:00 New York on weekdays;
  "always" is around the clock (crypto).
- `max_leverage` caps the account's leverage for that market, like a broker's per-class limits.
- `spread` is in price units, paid once per round trip; swap is the overnight financing.
"""

import math
import os
from dataclasses import dataclass, field
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

CLASSES = {
    "metals": "Metals",
    "energy": "Energy",
    "forex": "Forex",
    "indices": "Indices",
    "stocks": "US stocks",
    "crypto": "Crypto",
}


@dataclass(frozen=True)
class Instrument:
    symbol: str          # our key, also the Dukascopy datafeed code
    name: str
    asset_class: str     # a key of CLASSES
    ref_price: float     # rough current price, used to check the feed's price scale
    decimals: int        # price decimals shown and rounded to
    unit: str            # what one unit is ("ounce", "share", "barrel"...)
    lot: float           # units in one standard lot / contract
    default_units: float  # a sensible starting trade size
    spread: float        # price units, paid once per round trip
    max_leverage: int
    hours: str           # "fx", "us_stock" or "always"
    live: str = ""       # Finnhub symbol for live quotes
    # Overnight financing. Either fixed per unit per night (gold, kept as it always was) or
    # an annual rate on the position's value (everything else); negative is a cost.
    swap_long: float | None = None
    swap_short: float | None = None
    swap_long_pct: float = -6.0
    swap_short_pct: float = -1.0
    day: str = "ny17"    # when a daily bar closes: 17:00 New York ("ny17") or midnight UTC ("utc")
    point: float = 1000.0  # Dukascopy stores prices as integers; divide by this
    tags: tuple[str, ...] = field(default_factory=tuple)

    @property
    def class_label(self) -> str:
        return CLASSES[self.asset_class]

    def swap_per_unit(self, side: str, price: float) -> float:
        """Financing per unit for one night held, at this price."""
        fixed = self.swap_long if side == "long" else self.swap_short
        if fixed is not None:
            return fixed
        pct = self.swap_long_pct if side == "long" else self.swap_short_pct
        return price * pct / 100 / 365

    def is_open(self, at: datetime) -> bool:
        """Inside normal trading hours (holidays aside; a stale price catches those)."""
        if self.hours == "always":
            return True
        ny = at.astimezone(NY)
        wd, h = ny.weekday(), ny.hour  # Monday = 0
        if self.hours == "us_stock":
            return wd < 5 and time(9, 30) <= ny.time() < time(16, 0)
        if h == 17 or wd == 5 or (wd == 4 and h >= 17) or (wd == 6 and h < 18):
            return False
        return True

    def hours_text(self) -> str:
        return {
            "fx": "Sunday 18:00 to Friday 17:00 New York time, with a break from 17:00 to 18:00 each day",
            "us_stock": "09:30 to 16:00 New York time, Monday to Friday",
            "always": "around the clock, every day",
        }[self.hours]

    def round(self, price: float) -> float:
        return round(price, self.decimals)

    def public(self) -> dict:
        return {
            "symbol": self.symbol, "name": self.name, "asset_class": self.asset_class,
            "class_label": self.class_label, "decimals": self.decimals, "unit": self.unit, "lot": self.lot,
            "default_units": self.default_units, "spread": self.spread, "max_leverage": self.max_leverage,
            "hours": self.hours_text(), "open_now": self.is_open(datetime.now(timezone.utc)),
            "live": bool(self.live), "swap_long": self.swap_long, "swap_short": self.swap_short,
            "swap_long_pct": self.swap_long_pct, "swap_short_pct": self.swap_short_pct,
        }


_FX = dict(asset_class="forex", unit="unit", lot=100_000, default_units=10_000, max_leverage=500, hours="fx",
           decimals=5, point=100_000, swap_long_pct=-2.0, swap_short_pct=-2.0)
_STOCK = dict(asset_class="stocks", unit="share", lot=1, default_units=10, max_leverage=20, hours="us_stock",
              decimals=2, swap_long_pct=-6.0, swap_short_pct=-3.0)
_INDEX = dict(asset_class="indices", unit="contract", lot=1, default_units=1, max_leverage=200, hours="fx",
              decimals=1, swap_long_pct=-6.0, swap_short_pct=-1.0)

ALL: list[Instrument] = [
    Instrument("XAUUSD", "Gold", "metals", 2600, 2, "ounce", 100, 5, 0.30, 1000, "fx", "OANDA:XAU_USD",
               swap_long=-0.25, swap_short=0.05),
    Instrument("XAGUSD", "Silver", "metals", 30, 3, "ounce", 5000, 200, 0.03, 500, "fx", "OANDA:XAG_USD"),
    Instrument("LIGHTCMDUSD", "WTI crude oil", "energy", 70, 2, "barrel", 1000, 50, 0.04, 200, "fx",
               "OANDA:WTICO_USD"),
    Instrument("BRENTCMDUSD", "Brent crude oil", "energy", 75, 2, "barrel", 1000, 50, 0.04, 200, "fx",
               "OANDA:BCO_USD"),
    Instrument("GASCMDUSD", "Natural gas", "energy", 3, 3, "MMBtu", 10_000, 1000, 0.006, 200, "fx",
               "OANDA:NATGAS_USD"),
    Instrument("EURUSD", "Euro / US dollar", ref_price=1.1, spread=0.0001, live="OANDA:EUR_USD", **_FX),
    Instrument("GBPUSD", "British pound / US dollar", ref_price=1.3, spread=0.00015, live="OANDA:GBP_USD", **_FX),
    Instrument("AUDUSD", "Australian dollar / US dollar", ref_price=0.66, spread=0.00012, live="OANDA:AUD_USD", **_FX),
    Instrument("USA500IDXUSD", "S&P 500", ref_price=6000, spread=0.6, live="OANDA:SPX500_USD", **_INDEX),
    Instrument("USATECHIDXUSD", "Nasdaq 100", ref_price=21000, spread=1.5, live="OANDA:NAS100_USD", **_INDEX),
    Instrument("USA30IDXUSD", "Dow Jones 30", ref_price=44000, spread=3.0, live="OANDA:US30_USD", **_INDEX),
    Instrument("AAPLUSUSD", "Apple", ref_price=230, spread=0.06, live="AAPL", **_STOCK),
    Instrument("MSFTUSUSD", "Microsoft", ref_price=450, spread=0.10, live="MSFT", **_STOCK),
    Instrument("NVDAUSUSD", "Nvidia", ref_price=150, spread=0.05, live="NVDA", **_STOCK),
    Instrument("AMZNUSUSD", "Amazon", ref_price=210, spread=0.06, live="AMZN", **_STOCK),
    Instrument("TSLAUSUSD", "Tesla", ref_price=300, spread=0.15, live="TSLA", **_STOCK),
    Instrument("BTCUSD", "Bitcoin", "crypto", 90_000, 1, "coin", 1, 0.1, 30.0, 10, "always", "BINANCE:BTCUSDT",
               swap_long_pct=-10.0, swap_short_pct=-10.0, day="utc"),
    Instrument("ETHUSD", "Ethereum", "crypto", 3000, 2, "coin", 1, 1, 2.0, 10, "always", "BINANCE:ETHUSDT",
               swap_long_pct=-10.0, swap_short_pct=-10.0, day="utc"),
]

DEFAULT = "XAUUSD"
GOLD = ALL[0]


def _enabled() -> list[Instrument]:
    """MARKETS picks which instruments are loaded and offered ("all" or a comma list of symbols)."""
    raw = os.getenv("MARKETS", "all").strip()
    if not raw or raw.lower() == "all":
        return ALL
    want = {s.strip().upper() for s in raw.split(",") if s.strip()} | {DEFAULT}
    return [i for i in ALL if i.symbol in want]


ENABLED: list[Instrument] = _enabled()
BY_SYMBOL: dict[str, Instrument] = {i.symbol: i for i in ENABLED}


def get(symbol: str | None) -> Instrument:
    """The instrument for a symbol (gold when none is given). Raises KeyError for unknown ones."""
    if not symbol:
        return GOLD
    return BY_SYMBOL[symbol.upper()]


def by_live_symbol(live: str) -> Instrument | None:
    return next((i for i in ENABLED if i.live == live), None)


def fit_point(raw: float, ref: float) -> float:
    """The power of ten that turns a raw feed integer into a price closest to the reference price.
    The feed's scale differs by instrument and isn't published, so it is checked against real data."""
    if raw <= 0 or ref <= 0:
        return 1000.0
    k = round(math.log10(raw / ref))
    return float(10 ** max(0, min(k, 8)))
