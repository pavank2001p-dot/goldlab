# Trading Lab

Educational trading practice across markets, each with its own lab: Commodity Lab (gold, silver, oil, gas),
Forex Lab, Index Lab, Stock Lab and Crypto Lab. Charts, strategy backtests, paper trading, news insights and
risk-profile fit.
Nothing here is investment advice.

```
web/   Next.js site (Vercel). Proxies /api/* to the API so the session cookie is first-party.
api/   FastAPI + Postgres (Railway). Auth, price data, and later backtests, news and the assistant.
```

## What's built

- **Chart** (`web/src/components/PriceChart.tsx`, `api/app/prices.py`, `api/app/live.py`): 13 timeframes
  from 1 second to 1 month, zoom, full screen and a live price. Hourly and daily bars go back to `HISTORY_SINCE` (2003-05-01);
  minute bars cover the last `MINUTE_DAYS` (60) for gold and `MARKET_MINUTE_DAYS` (14) for other markets, and one-second bars the last `SECOND_DAYS` (2), from
  Dukascopy. Other timeframes are aggregated on request. Live quotes stream from Finnhub's websocket
  (OANDA:XAU_USD) when `FINNHUB_API_KEY` is set (turn off with `LIVE_PRICES=false`); they move the newest
  candle and are saved as 1s/1m/1h bars until Dukascopy's data for that hour replaces them. The **All**
  button shows every month since 1833 on a log scale (see Data below).
- **Accounts** (`api/app/auth.py`, `api/app/mailer.py`): email and password sign-up, cookie sessions, email
  confirmation, password reset by email link and Google sign-in. Links are single-use and stored only as a
  SHA-256 hash; confirm links last `VERIFY_TOKEN_HOURS` (48), reset links `RESET_TOKEN_MINUTES` (60), and each
  kind is sent at most once a minute per account. A reset ends every other session. "Forgot password" answers
  the same whether or not the account exists. Google sign-in (OpenID Connect code flow with PKCE) links to an
  existing account with the same Google-confirmed email; if that account's email was never confirmed, its
  password is removed so whoever registered it first can't get back in. Unconfirmed accounts aren't locked out
  of anything; the account page asks them to confirm. Email goes through `EMAIL_PROVIDER`: `resend`
  (recommended), `smtp` (any SMTP service) or `console`, which prints emails to the API log for local work.
- **Backtests** (`api/app/backtest.py`): 23 strategies. Trend following: moving-average crossover, triple moving
  average, price vs moving average, channel breakout, MACD, Supertrend, Parabolic SAR, ADX, Keltner breakout, momentum,
  Ichimoku cloud, Heikin-Ashi, Aroon, Bollinger squeeze breakout and inside-bar breakout. Mean reversion: RSI, RSI(2)
  pullback, Fibonacci pullback, Bollinger bands, stochastic, CCI and Williams %R. Plus buy and hold as a benchmark.
  Signals on each close fill at the next open; spread, overnight swap, stop loss and take profit are modelled, and a
  test stops if the account reaches zero. Results are saved per user. (VWAP and grid strategies aren't included: spot
  gold has no reliable volume, and a grid holds many positions at once, which this engine doesn't model.)
- **Strategy builder** (`api/app/custom.py`, `/strategies/builder`): users combine 21 indicators (price, averages,
  RSI, MACD, ADX, Bollinger bands, ATR and more) with "is above", "is below", "crosses above" and "crosses below" into
  rules for opening and closing longs and shorts, starting from a template or from scratch. Saved strategies run in
  the backtester, the strategy finder (with stops and sizes fitted to the profile), the agent and the assistant.
  A live preview (`/custom-strategies/preview`) re-tests the rules on every edit and marks each trade on a chart.
- **Habits** (`api/app/achievements.py`, `/achievements`): badges for disciplined process (risk quiz done, ideas
  backtested, a stop on every paper trade, risk inside the profile's limit, a steady pace, notes in the trade log)
  and a journal streak. They never reward profit. Shown on the signed-in home dashboard and the account page.
- **Look and feel**: dark, light or follow-the-device themes and four accent colours (`web/src/lib/theme.ts`), a
  first-visit tour, fill confirmations, and shareable result images drawn in the browser (`ShareCard.tsx`).
- **Prop challenge** (`api/app/prop.py`, `/paper/prop`): practise a funded-trader style evaluation on the paper
  account. Starter ($10k, +8%, 6% daily and 12% overall loss limits), two-step (+10% then +5%, 5% / 10%) and
  one-step (+10%, 3% / 6%) plans in $10k to $200k sizes, or custom rules. Limits are checked against equity at every
  minute bar's worst price (open trades included, day rolls at 17:00 New York); breaking one closes everything and
  fails the challenge. A phase passes at the target with nothing open and the minimum trading days met; each phase
  starts on a fresh account. A live rule panel on the paper page warns about trades without stops or stops that would
  break a limit, links the lesson for the rule at risk, and a pass gives a shareable certificate image. Balance and
  leverage are locked during a challenge; starting over or leaving ends it.
- **Daily Candle** (`api/app/daily.py`, home page): one real moment of gold history a day, the same for everyone. The
  chart stops at an hour where the next 12 hours moved a lot (chosen once per day from 40 seeded guesses and stored);
  the date and price level are hidden until the player picks buy, sell or wait. Then the next 12 hours play out, with
  the real date, what $1,000 would have made, the worst move against the call and the crowd split. Signed-in plays
  are kept (one a day) for a streak; signed-out plays are answered and remembered in the browser.
- **Money Mirror** (`web/src/components/MoneyMirror.tsx`): the user names what they might really trade with, their
  monthly pay and something they are saving for, in their own currency (saved as the `mirror` pref). The order ticket
  then shows each stop as real money, hours of work and a share of the goal, and the home desk shows paper results so
  far as a goal jar.
- **Trade log** (`api/app/trades.py`): manual entry or CSV import (MetaTrader 4/5 and most broker exports; gold
  rows only; re-imports skip known tickets). Produces the same report as a backtest (`api/app/report.py`).

- **News** (`api/app/news.py`): Finnhub headlines filtered to gold and its macro drivers, each tagged by
  Claude (structured JSON output, model set by `NEWS_MODEL`) as bullish, bearish or neutral for gold with a
  one-line reason. Needs `FINNHUB_API_KEY` and `ANTHROPIC_API_KEY`; without them the page says it isn't connected.
- **US event calendar** (`api/app/calendar.py`): 2026 FOMC decisions seeded from the Fed's calendar, plus
  this week's USD high/medium-impact releases from the public ForexFactory JSON feed (`CALENDAR_FEED_URL`).
- **Trade scenarios** (`api/app/scenarios.py`): for a trade opened now, 2,000 simulated paths built from real
  trading days drawn at random from the lookback period (close, high and low moves). Shows price ranges by date,
  how often the stop or target is hit first, and the profit or loss spread. The past average move is removed by
  default, so it takes no view on direction. A simulation, not a forecast.
- **Paper trading** (`api/app/paper.py`): a practice account in virtual dollars. $10,000 at 1:20 to start; users
  can start over with any balance up to $1 trillion, add or take out virtual money, and pick leverage from 1:1 to
  1:1000 like a forex broker (margin held is 1/N of each position's value, stop-out at a 50% margin level).
  Market, limit and stop orders with optional stop loss and take profit fill at the real bid and ask, with the
  same spread and overnight swap as the backtester.
  Pending orders and stops are checked against every saved minute bar since the account was last opened, so
  nothing is missed while the page is closed.
  **Chart trading** (`web/src/components/chart/TradeLines.tsx`): positions and pending orders are drawn on the
  chart; drag a pending order's line to move it (its stop and target move with it), drag stop loss and take
  profit lines to move them, add or remove them, and close or cancel from the chart. New orders start from the
  chart's Buy and Sell buttons or by right-clicking a price (press and hold on touch screens), then are adjusted
  by dragging before they're placed. `PATCH /paper/orders/{id}` moves a pending order.
  **Order tools** like a broker's: a trailing stop that follows the best price by a fixed distance, a break-even button
  (`POST /paper/positions/{id}/breakeven`, also a **BE** button on the chart), partial close (`POST
  /paper/positions/{id}/close` with `units`; the closed part becomes its own trade), one-cancels-other pairs of pending
  orders (`oco_with`), one-click trading (skips the review step; saved to the account), and sizing by risk % right in
  the order ticket from the stop distance. Closed paper trades get the same report and profile fit as the
  trade log. No real money or broker is involved.
- **Manual backtesting** (`api/app/sessions.py`, `/paper/sessions`): replay any date range candle by candle at 5m, 15m
  or 1h (up to 3,000 candles), with the 1h, 4h or daily chart beside it built from the same candles as they appear.
  Blind mode hides dates and times until the session ends, and progress saves as you go, so a session can be paused
  and resumed on any device. Finished sessions are settled on the server with the same rules as the replay.
- **Risk quiz** (`api/app/risk.py`): 17 questions in five parts place a user as conservative, moderate or aggressive,
  with risk-per-trade, drawdown and leverage limits.
- **Profile fit** (`api/app/fit.py`): every backtest and the trade log are checked against the user's
  limits (drawdown, risk per trade from the stop distance or the largest loss, and position size against
  the account), with a trade size that would have stayed inside them.
- **Strategy finder** (`api/app/planner.py`, `/strategies`): tries every strategy with three settings (default,
  half and double length) and three stop distances for the chosen profile, on daily (3 to 20 years) or hourly
  (1 or 2 years) candles. Each trade is sized as a share of the account so a stop-out costs at most the
  profile's risk per trade, within its leverage cap, and shrunk further if the result breaks a limit.
  Settings are picked on the first 70% of the period and re-run unchanged on the last 30%; both are shown,
  next to owning gold unleveraged. Results are cached in memory for six hours. Backtests can also size
  trades as a % of the account (`size_pct`).
- **Strategy agent** (`api/app/agent.py`, `/paper/agent`): tests a strategy on past prices and explains what went
  wrong: losses by kind of market (uptrend, downtrend or sideways, from ADX and the 50-bar average), trades
  against the trend, direction, stops inside normal volatility (ATR), volatile periods, costs, losing
  streaks, and the worst drawdown with the Fed and inflation dates and gold headlines from then. Fixes aimed
  at those findings (wider stop at the same risk, one direction, slower or faster settings, smaller size, a
  strategy of the other kind) are re-run on the same prices and on the last 30% alone. The agent can then
  trade the strategy in the user's paper account: on each new closed candle it opens, closes or flips one
  position with its stop, and after a stop-out waits for the signal to change, like the backtester. It runs
  every minute with the scheduler and whenever the page is open. Its live trades get the same diagnosis and
  are compared with a backtest of the same days. The AI coach is the assistant with two more tools
  (`my_agent`, `diagnose_strategy`), so it explains these results and answers "what if" questions from data.
- **AI assistant** (`api/app/assistant.py`): Claude with tools over the site's own data (prices, backtests,
  the trade log, risk profile, news, calendar), so numbers come from the database rather than the model.
  Answers run in the background and the page polls for them. Each user gets `ASSISTANT_DAILY_LIMIT`
  questions per UTC day (default 20; failed answers don't count). Model set by `ASSISTANT_MODEL`.
  Asked to build a strategy, it writes its own builder rules, tests them with `test_rules` (results for the whole
  period, the earlier 70% and the last 30% alone, next to buy and hold), adjusts a few times, then saves the version
  it describes with `save_strategy` and links to it in the builder (`/strategies/builder?id=<id>`).
- **Language and local gold price** (`web/src/lib/i18n.tsx`, `web/src/lib/localPrice.ts`, `api/app/fx.py`): the
  settings menu (the moon or sun button) picks a language, a currency and a gold unit (troy ounce, gram, 10 grams,
  tola, kilogram). The English text in the code is the translation key, so untranslated text stays in English.
  To add a language, copy `web/src/i18n/hi.ts`, translate the values, and add it to `CATALOGS` and `LANGS`;
  `npm run i18n:check` (also run in CI) lists strings a catalog is missing. Right-to-left languages flip the layout;
  charts stay left to right. Hindi and Arabic are AI drafts marked as such until a native speaker checks them.
  The gold price is also shown converted, for example INR per 10 grams or AED per gram, as spot before local taxes
  and duties. Rates are ECB reference rates via Frankfurter (`FX_URL`), cached six hours; AED and SAR use their
  dollar pegs. Trading and reports stay in US dollars per ounce.
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

Long-run history: `api/app/data/gold_history_monthly.csv` holds monthly USD prices since 1833 from the
datahub.io gold-prices dataset (ODC-PDDL-1.0, public domain): yearly averages from Timothy Green's tables
until 1959, then World Bank monthly averages. The API stores them as `1mo` bars at startup and uses them
for monthly candles before the first daily bar, and the assistant uses them for questions about earlier
years. Daily charts and backtests use only the hourly data.

### Other markets

Besides gold, the charts, backtests and paper trading work on silver, WTI and Brent oil, natural gas,
EUR/USD, GBP/USD, AUD/USD, the S&P 500, Nasdaq 100 and Dow Jones, Apple, Microsoft, Nvidia, Amazon,
Tesla, Bitcoin and Ether (all quoted in US dollars). The list and each market's rules live in
`api/app/instruments.py`: trading hours (forex hours, US stock hours, or around the clock for crypto),
contract size, a leverage cap (the account's leverage applies up to it), spread and overnight swap.

- History comes from the same free Dukascopy feed, no key needed, from `MARKET_HISTORY_SINCE`
  (default 2015-01-01). Gold keeps its full history from 2003.
- Live quotes come from Finnhub's free websocket with the same `FINNHUB_API_KEY`: OANDA prices for
  metals, energy, forex and indices, US stock trades, and Binance for crypto.
- `MARKETS` limits which markets are fetched (`all` by default, or a comma-separated list of symbols such as
  `XAUUSD,EURUSD,AAPLUSUSD`). `SECOND_SYMBOLS` lists the markets that keep 1-second bars (gold by default).
- Not included: Indian (NSE/BSE) stocks and futures, which have no free feed here and would need a paid
  data provider; and markets not priced in dollars (USD/JPY, the DAX), which would need currency conversion.

Switching source wipes the old bars so the two never mix (the monthly history is kept). `python -m app.ingest update` refreshes the
latest bars; set `ENABLE_SCHEDULER=true` to have the API do this every `UPDATE_INTERVAL_MIN` minutes.

## Deploy

**API on Railway**
1. New project from this GitHub repo, root directory `api` (uses `api/Dockerfile`), and add a Postgres plugin.
2. Variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `JWT_SECRET=<long random string>`,
   `COOKIE_SECURE=true`, `PRICE_SOURCE=dukascopy`, `ENABLE_SCHEDULER=true`, and for news and the
   assistant `FINNHUB_API_KEY` and `ANTHROPIC_API_KEY`. Optional: `ASSISTANT_DAILY_LIMIT` (default 20).
   For account emails: `APP_URL=https://<your-site>`, `RESEND_API_KEY` and `EMAIL_FROM` (an address on a
   domain verified in Resend, e.g. `Trading Lab <no-reply@yourdomain.com>`). For Google sign-in:
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Google Cloud OAuth client (type "Web application")
   whose authorised redirect URI is `https://<your-site>/api/auth/google/callback`. The Google button only
   appears once both are set.
3. First boot starts the backfill from 2003 in the background; the chart fills in as it runs. A database
   first filled from 2010 is extended back to `HISTORY_SINCE` once, on the next scheduled update.

**Site on Vercel**
1. Import the repo, root directory `web`.
2. Variable: `API_URL=https://<your-railway-api-domain>`.
3. Add your own domain in Vercel when ready.
