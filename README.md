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
   `COOKIE_SECURE=true`, `PRICE_SOURCE=dukascopy`, `ENABLE_SCHEDULER=true`.
3. First boot starts the backfill from 2010 in the background; the chart fills in as it runs.

**Site on Vercel**
1. Import the repo, root directory `web`.
2. Variable: `API_URL=https://<your-railway-api-domain>`.
3. Add your own domain in Vercel when ready.
