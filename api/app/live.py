"""Live prices from Finnhub's websocket: OANDA quotes for gold, forex, energy and index CFDs,
US stock trades, and Binance crypto trades (each market's `live` symbol in app.instruments).

The free historical feed publishes each hour only after it ends, so this fills the gap:
every quote updates the latest price, which the chart polls, and is rolled into 1-second,
1-minute and 1-hour bars that are saved every few seconds. When the historical feed later
covers the same period, its bars replace these.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter

from fastapi import HTTPException

from . import config
from . import instruments as ins
from .ingest import Bar, upsert

log = logging.getLogger("live")
router = APIRouter(prefix="/prices", tags=["prices"])

FINNHUB_WS = "wss://ws.finnhub.io"
SYMBOL = ins.GOLD.live  # gold's Finnhub symbol
FLUSH_SECONDS = 5
STEPS = {"1s": 1, "1m": 60, "1h": 3600}


class Live:
    def __init__(self, symbol: str = config.SYMBOL) -> None:
        self.symbol = symbol
        self.price: float | None = None
        self.t: float | None = None  # unix seconds of the latest quote
        self.connected = False
        self.bars: dict[str, dict[int, Bar]] = {tf: {} for tf in STEPS}

    def tick(self, price: float, t: float, volume: float = 0.0) -> None:
        if self.t is not None and t < self.t - 5:  # ignore stale or out-of-order quotes
            return
        self.price, self.t = price, max(t, self.t or t)
        for tf, step in STEPS.items():
            k = int(t) // step * step
            b = self.bars[tf].get(k)
            if b is None:
                self.bars[tf][k] = Bar(datetime.fromtimestamp(k, timezone.utc), price, price, price, price, volume)
            else:
                b.high, b.low, b.close = max(b.high, price), min(b.low, price), price
                b.volume += volume

    def flush(self) -> int:
        """Save bars and keep only the bar still in progress for each timeframe."""
        n = 0
        for tf, bars in self.bars.items():
            if not bars:
                continue
            n += upsert(list(bars.values()), tf, self.symbol)
            latest = max(bars)
            self.bars[tf] = {latest: bars[latest]}
        return n

    def snapshot(self) -> dict:
        age = None if self.t is None else round(time.time() - self.t, 1)
        return {"price": self.price, "t": self.t, "age_seconds": age, "connected": self.connected,
                "configured": bool(config.FINNHUB_API_KEY and config.LIVE_PRICES)}


feed = Live()  # gold
_others: dict[str, Live] = {i.symbol: Live(i.symbol) for i in ins.ENABLED if i.live and i.symbol != ins.GOLD.symbol}


def feed_of(symbol: str) -> Live | None:
    """The live feed for one of our symbols (None when the market has no live source)."""
    return feed if symbol == ins.GOLD.symbol else _others.get(symbol)


def all_feeds() -> list[Live]:
    return [feed, *_others.values()]


def handle(message: str) -> None:
    msg = json.loads(message)
    if msg.get("type") != "trade":
        return
    for d in msg.get("data") or []:
        inst = ins.by_live_symbol(d.get("s") or "")
        f = feed_of(inst.symbol) if inst else None
        t = d.get("t", 0) / 1000
        # Stocks also print pre- and after-market trades; keep to the hours the chart and paper account use.
        if f and d.get("p") and inst.is_open(datetime.fromtimestamp(t, timezone.utc)):
            f.tick(float(d["p"]), t, float(d.get("v") or 0))


async def run() -> None:
    """Stay connected, reconnecting with backoff; save bars every few seconds."""
    from websockets.asyncio.client import connect

    async def flusher():
        while True:
            await asyncio.sleep(FLUSH_SECONDS)
            try:
                for f in all_feeds():
                    await asyncio.to_thread(f.flush)
            except Exception:
                log.exception("saving live bars failed")

    saver = asyncio.create_task(flusher())
    delay = 1
    try:
        while True:
            try:
                async with connect(f"{FINNHUB_WS}?token={config.FINNHUB_API_KEY}", ping_interval=30) as ws:
                    for i in ins.ENABLED:
                        if i.live:
                            await ws.send(json.dumps({"type": "subscribe", "symbol": i.live}))
                    for f in all_feeds():
                        f.connected = True
                    delay = 1
                    log.info("live prices connected")
                    async for message in ws:
                        handle(message)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("live prices disconnected: %s", e)
            for f in all_feeds():
                f.connected = False
            await asyncio.sleep(delay)
            delay = min(delay * 2, 300)
    finally:
        saver.cancel()


@router.get("/live")
def live(symbol: str = config.SYMBOL):
    try:
        inst = ins.get(symbol)
    except KeyError:
        raise HTTPException(404, f"Unknown market {symbol}")
    f = feed_of(inst.symbol)
    if f is None:
        return {"price": None, "t": None, "age_seconds": None, "connected": False, "configured": False}
    return f.snapshot()
