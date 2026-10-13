import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import auth, backtest, calendar, config, db, ingest, news, prices, risk, trades

log = logging.getLogger("api")


async def _price_updater():
    while True:
        try:
            n = await asyncio.to_thread(ingest.update, config.PRICE_SOURCE)
            log.info("price update stored %d bars", n)
        except Exception:
            log.exception("price update failed")
        await asyncio.sleep(config.UPDATE_INTERVAL_MIN * 60)


async def _news_updater():
    while True:
        try:
            added, tagged = await asyncio.to_thread(news.update)
            events = await asyncio.to_thread(calendar.update)
            log.info("news update: %d new, %d tagged; calendar: %d events", added, tagged, events)
        except Exception:
            log.exception("news update failed")
        await asyncio.sleep(config.NEWS_INTERVAL_MIN * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.migrate()
    calendar.seed_fomc()
    tasks = [asyncio.create_task(_price_updater()), asyncio.create_task(_news_updater())] if config.ENABLE_SCHEDULER else []
    yield
    for task in tasks:
        task.cancel()
    db.close()


app = FastAPI(title="GoldLab API", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(prices.router)
app.include_router(backtest.router)
app.include_router(trades.router)
app.include_router(news.router)
app.include_router(calendar.router)
app.include_router(risk.router)


@app.get("/health")
def health():
    with db.conn() as c:
        c.execute("SELECT 1")
    return {"ok": True}
