import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import auth, backtest, config, db, ingest, prices, trades

log = logging.getLogger("api")


async def _price_updater():
    while True:
        try:
            n = await asyncio.to_thread(ingest.update, config.PRICE_SOURCE)
            log.info("price update stored %d bars", n)
        except Exception:
            log.exception("price update failed")
        await asyncio.sleep(config.UPDATE_INTERVAL_MIN * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.migrate()
    task = asyncio.create_task(_price_updater()) if config.ENABLE_SCHEDULER else None
    yield
    if task:
        task.cancel()
    db.close()


app = FastAPI(title="GoldLab API", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(prices.router)
app.include_router(backtest.router)
app.include_router(trades.router)


@app.get("/health")
def health():
    with db.conn() as c:
        c.execute("SELECT 1")
    return {"ok": True}
