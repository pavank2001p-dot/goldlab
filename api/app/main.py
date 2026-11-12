import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import achievements, agent, analytics, assistant, auth, backtest, calendar, coach, config, custom, daily, db, fit, fx, ingest, lab, learn, live, news, paper, planner, practice, prefs, prices, prop, review, risk, scenarios, sessions, trades

log = logging.getLogger("api")


async def _price_updater():
    while True:
        try:
            n = await asyncio.to_thread(ingest.update_all, config.PRICE_SOURCE)
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


async def _agent_runner():
    while True:
        try:
            n = await asyncio.to_thread(agent.step_all)
            if n:
                log.info("strategy agents traded %d times", n)
        except Exception:
            log.exception("agent run failed")
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.migrate()
    ingest.load_monthly_history()
    calendar.seed_fomc()
    tasks = ([asyncio.create_task(_price_updater()), asyncio.create_task(_news_updater()),
              asyncio.create_task(_agent_runner())] if config.ENABLE_SCHEDULER else [])
    if config.ENABLE_SCHEDULER and config.LIVE_PRICES and config.FINNHUB_API_KEY and config.PRICE_SOURCE != "sample":
        tasks.append(asyncio.create_task(live.run()))
    yield
    for task in tasks:
        task.cancel()
    db.close()


app = FastAPI(title="Trading Lab API", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(prices.router)
app.include_router(live.router)
app.include_router(backtest.router)
app.include_router(custom.router)
app.include_router(trades.router)
app.include_router(news.router)
app.include_router(calendar.router)
app.include_router(risk.router)
app.include_router(fit.router)
app.include_router(planner.router)
app.include_router(scenarios.router)
app.include_router(paper.router)
app.include_router(prop.router)
app.include_router(agent.router)
app.include_router(assistant.router)
app.include_router(achievements.router)
app.include_router(lab.router)
app.include_router(practice.router)
app.include_router(sessions.router)
app.include_router(review.router)
app.include_router(coach.router)
app.include_router(learn.router)
app.include_router(prefs.router)
app.include_router(fx.router)
app.include_router(daily.router)
app.include_router(analytics.router)


@app.get("/health")
def health():
    with db.conn() as c:
        c.execute("SELECT 1")
    return {"ok": True}
