# GoldLab

Educational XAU/USD (gold) analysis: charts, strategy backtests, news insights and risk-profile fit.
Nothing here is investment advice.

```
web/   Next.js site (Vercel). Proxies /api/* to the API so the session cookie is first-party.
api/   FastAPI + Postgres (Railway). Auth, price data, and later backtests, news and the assistant.
```

## What's built

- **Chart**: hourly and daily XAU/USD candles back to 2010, refreshing every minute.
- **Accounts**: email and password sign-up, cookie sessions.
- **Backtests** (`api/app/backtest.py`): moving-average crossover, channel breakout, RSI mean reversion and
  Bollinger band reversion. Signals on each close fill at the next open; spread, overnight swap,
  stop loss and take profit are modelled, and a test stops if the account reaches zero. Results are saved per user.
- **Trade log** (`api/app/trades.py`): manual entry or CSV import (MetaTrader 4/5 and most broker exports; gold
  rows only; re-imports skip known tickets). Produces the same report as a backtest (`api/app/report.py`).

- **News** (`api/app/news.py`): Finnhub headlines filtered to gold and its macro drivers, each tagged by
  Claude (structured JSON output, model set by `NEWS_MODEL`) as bullish, bearish or neutral for gold with a
  one-line reason. Needs `FINNHUB_API_KEY` and `ANTHROPIC_API_KEY`; without them the page says it isn't connected.
- **US event calendar** (`api/app/calendar.py`): 2026 FOMC decisions seeded from the Fed's calendar, plus
  this week's USD high/medium-impact releases from the public ForexFactory JSON feed (`CALENDAR_FEED_URL`).
- **Risk quiz** (`api/app/risk.py`): eight questions place a user as conservative, moderate or aggressive,
  with risk-per-trade, drawdown and leverage limits.
- **Profile fit** (`api/app/fit.py`): every backtest and the trade log are checked against the user's
  limits (drawdown, risk per trade from the stop distance or the largest loss, and position size against
  the account), with a trade size that would have stayed inside them.
- **AI assistant** (`api/app/assistant.py`): Claude with tools over the site's own data (prices, backtests,
  the trade log, risk profile, news, calendar), so numbers come from the database rather than the model.
  Answers run in the background and the page polls for them. Each user gets `ASSISTANT_DAILY_LIMIT`
  questions per UTC day (default 20; failed answers don't count). Model set by `ASSISTANT_MODEL`.
- **Disclaimer** page at `/disclaimer`, linked from the footer and the assistant.

## Run locally

Needs Node 22, Python 3.13 and Postgres 16.

```bash
# database
createuser -s gold && createdb -O gold gold   # password "gold", or set DATABASE_URL

# api
cd api
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m app.ingest backfill --source sample   # offline demo prices since 2010
# or: .venv/bin/python -m app.ingest backfill --source dukascopy   (real prices, ~200 small downloads)
.venv/bin/uvicorn app.main:app --reload --port 8000

# web (second terminal)
cd web
npm install && npm run dev        # http://localhost:3000
```

Tests: `cd api && .venv/bin/pytest` (uses a `gold_test` database), `cd web && npm run lint && npm run build`.

## Price data

Hourly bars are stored; daily bars are rebuilt from them (17:00 New York close).

- `dukascopy`: real bid prices from Dukascopy's free historical feed. Finished months come from monthly
  hour-candle files, the current month from daily minute files, and today from hourly tick files.
- `sample`: offline demo data. Real monthly average prices (World Bank via datasets/gold-prices, public
  domain) with simulated hours in between. The site labels it as demo data.

Switching source wipes the old bars so the two never mix. `python -m app.ingest update` refreshes the
latest bars; set `ENABLE_SCHEDULER=true` to have the API do this every `UPDATE_INTERVAL_MIN` minutes.

## Deploy

**API on Railway**
1. New project from this GitHub repo, root directory `api` (uses `api/Dockerfile`), and add a Postgres plugin.
2. Variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `JWT_SECRET=<long random string>`,
   `COOKIE_SECURE=true`, `PRICE_SOURCE=dukascopy`, `ENABLE_SCHEDULER=true`, and for news and the
   assistant `FINNHUB_API_KEY` and `ANTHROPIC_API_KEY`. Optional: `ASSISTANT_DAILY_LIMIT` (default 20).
3. First boot starts the backfill from 2010 in the background; the chart fills in as it runs.

**Site on Vercel**
1. Import the repo, root directory `web`.
2. Variable: `API_URL=https://<your-railway-api-domain>`.
3. Add your own domain in Vercel when ready.
