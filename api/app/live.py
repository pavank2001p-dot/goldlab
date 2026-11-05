"""Live gold prices from Finnhub's websocket (OANDA:XAU_USD quotes).

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

from . import config
from .ingest import Bar, upsert

log = logging.getLogger("live")
router = APIRouter(prefix="/prices", tags=["prices"])

FINNHUB_WS = "wss://ws.finnhub.io"
SYMBOL = "OANDA:XAU_USD"
FLUSH_SECONDS = 5
STEPS = {"1s": 1, "1m": 60, "1h": 3600}


class Live:
    def __init__(self) -> None:
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
            n += upsert(list(bars.values()), tf)
            latest = max(bars)
            self.bars[tf] = {latest: bars[latest]}
        return n

    def snapshot(self) -> dict:
        age = None if self.t is None else round(time.time() - self.t, 1)
        return {"price": self.price, "t": self.t, "age_seconds": age, "connected": self.connected,
                "configured": bool(config.FINNHUB_API_KEY and config.LIVE_PRICES)}


feed = Live()


def handle(message: str) -> None:
    msg = json.loads(message)
    if msg.get("type") != "trade":
        return
    for d in msg.get("data") or []:
        if d.get("s") == SYMBOL and d.get("p"):
            feed.tick(float(d["p"]), d["t"] / 1000, float(d.get("v") or 0))


async def run() -> None:
    """Stay connected, reconnecting with backoff; save bars every few seconds."""
    from websockets.asyncio.client import connect

    async def flusher():
        while True:
            await asyncio.sleep(FLUSH_SECONDS)
            try:
                await asyncio.to_thread(feed.flush)
            except Exception:
                log.exception("saving live bars failed")

    saver = asyncio.create_task(flusher())
    delay = 1
    try:
        while True:
            try:
                async with connect(f"{FINNHUB_WS}?token={config.FINNHUB_API_KEY}", ping_interval=30) as ws:
                    await ws.send(json.dumps({"type": "subscribe", "symbol": SYMBOL}))
                    feed.connected, delay = True, 1
                    log.info("live prices connected")
                    async for message in ws:
                        handle(message)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("live prices disconnected: %s", e)
            feed.connected = False
            await asyncio.sleep(delay)
            delay = min(delay * 2, 300)
    finally:
        saver.cancel()


@router.get("/live")
def live():
    return feed.snapshot()
