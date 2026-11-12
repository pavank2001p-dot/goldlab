CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Accounts made with Google have no password until they set one through a reset link.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
-- Bumped on password reset so older sessions stop working.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub) WHERE google_sub IS NOT NULL;

-- One-time links sent by email. Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    email      TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, purpose, created_at DESC);

-- One row per bar. tf is '1s', '1m', '1h' or '1d'; ts is the bar's open time in UTC.
CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT             NOT NULL,
    tf     TEXT             NOT NULL,
    ts     TIMESTAMPTZ      NOT NULL,
    open   DOUBLE PRECISION NOT NULL,
    high   DOUBLE PRECISION NOT NULL,
    low    DOUBLE PRECISION NOT NULL,
    close  DOUBLE PRECISION NOT NULL,
    volume DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, tf, ts)
);

-- Small key/value store, e.g. which source the loaded prices came from.
CREATE TABLE IF NOT EXISTS meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtests (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    params     JSONB NOT NULL,
    stats      JSONB NOT NULL,
    result     JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS backtests_user_idx ON backtests (user_id, created_at DESC);

-- A user's own trades. Prices in USD per ounce, units in ounces (1 standard lot = 100 oz).
CREATE TABLE IF NOT EXISTS trades (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side        TEXT NOT NULL CHECK (side IN ('long', 'short')),
    units       DOUBLE PRECISION NOT NULL CHECK (units > 0),
    open_time   TIMESTAMPTZ NOT NULL,
    open_price  DOUBLE PRECISION NOT NULL CHECK (open_price > 0),
    close_time  TIMESTAMPTZ,
    close_price DOUBLE PRECISION CHECK (close_price > 0),
    stop_loss   DOUBLE PRECISION,
    take_profit DOUBLE PRECISION,
    fees        DOUBLE PRECISION NOT NULL DEFAULT 0,  -- commissions, as a positive cost
    swap        DOUBLE PRECISION NOT NULL DEFAULT 0,  -- signed, as the broker reports it
    notes       TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,                                 -- broker ticket, to skip duplicates on re-import
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trades_user_idx ON trades (user_id, open_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS trades_external_idx ON trades (user_id, external_id) WHERE external_id IS NOT NULL;

-- Gold-relevant headlines, tagged by Claude with their likely effect on gold.
CREATE TABLE IF NOT EXISTS news (
    id           BIGSERIAL PRIMARY KEY,
    source       TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    headline     TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    url          TEXT NOT NULL DEFAULT '',
    publisher    TEXT NOT NULL DEFAULT '',
    published_at TIMESTAMPTZ NOT NULL,
    relevance    SMALLINT NOT NULL DEFAULT 1,  -- 2 = mentions gold directly, 1 = macro driver
    impact       TEXT CHECK (impact IN ('bullish', 'bearish', 'neutral')),
    reason       TEXT,
    tagged_at    TIMESTAMPTZ,
    UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS news_published_idx ON news (published_at DESC);

-- Scheduled market-moving events (Fed meetings, inflation, jobs...).
CREATE TABLE IF NOT EXISTS events (
    id       BIGSERIAL PRIMARY KEY,
    ts       TIMESTAMPTZ NOT NULL,
    country  TEXT NOT NULL DEFAULT 'USD',
    title    TEXT NOT NULL,
    impact   TEXT NOT NULL DEFAULT 'High',
    forecast TEXT NOT NULL DEFAULT '',
    previous TEXT NOT NULL DEFAULT '',
    source   TEXT NOT NULL,
    UNIQUE (title, ts)
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);

CREATE TABLE IF NOT EXISTS risk_profiles (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    answers    JSONB NOT NULL,
    score      INTEGER NOT NULL,
    profile    TEXT NOT NULL CHECK (profile IN ('conservative', 'moderate', 'aggressive')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI assistant questions. Answers are produced in the background and polled by the page;
-- rows also count each user's questions toward the daily limit.
CREATE TABLE IF NOT EXISTS assistant_questions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question    TEXT NOT NULL,
    history     JSONB NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
    answer      TEXT,
    tools_used  JSONB NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS assistant_user_day_idx ON assistant_questions (user_id, created_at DESC);

-- Paper trading: a practice account in virtual dollars, filled against real XAU/USD prices.
CREATE TABLE IF NOT EXISTS paper_accounts (
    user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    starting_balance DOUBLE PRECISION NOT NULL,
    balance          DOUBLE PRECISION NOT NULL,          -- cash after closed positions
    leverage         INTEGER NOT NULL DEFAULT 20,        -- 1:N; margin held is 1/N of each position's value
    checked_at       TIMESTAMPTZ NOT NULL DEFAULT now(), -- prices up to here have been applied
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS leverage INTEGER NOT NULL DEFAULT 20;

-- Limit and stop orders waiting for the price to reach them. Market orders open a position at once.
CREATE TABLE IF NOT EXISTS paper_orders (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side        TEXT NOT NULL CHECK (side IN ('long', 'short')),
    kind        TEXT NOT NULL CHECK (kind IN ('limit', 'stop')),
    units       DOUBLE PRECISION NOT NULL CHECK (units > 0),
    price       DOUBLE PRECISION NOT NULL CHECK (price > 0),
    stop_loss   DOUBLE PRECISION,
    take_profit DOUBLE PRECISION,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'cancelled')),
    note        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS paper_orders_user_idx ON paper_orders (user_id, status);

CREATE TABLE IF NOT EXISTS paper_positions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    side         TEXT NOT NULL CHECK (side IN ('long', 'short')),
    units        DOUBLE PRECISION NOT NULL CHECK (units > 0),
    entry_price  DOUBLE PRECISION NOT NULL,
    opened_at    TIMESTAMPTZ NOT NULL,
    stop_loss    DOUBLE PRECISION,
    take_profit  DOUBLE PRECISION,
    order_kind   TEXT NOT NULL DEFAULT 'market',
    closed_at    TIMESTAMPTZ,
    exit_price   DOUBLE PRECISION,
    close_reason TEXT,
    swap         DOUBLE PRECISION,
    pnl          DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS paper_positions_user_idx ON paper_positions (user_id, closed_at);

-- Strategy agent: runs one strategy automatically in the user's paper account.
CREATE TABLE IF NOT EXISTS paper_agents (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    config      JSONB NOT NULL,                     -- strategy, settings, candles, direction, stop, size
    status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'stopped')),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at  TIMESTAMPTZ,
    last_bar    TIMESTAMPTZ,                        -- newest closed candle it has acted on
    signal      SMALLINT NOT NULL DEFAULT 0,
    blocked     SMALLINT NOT NULL DEFAULT 0,        -- side stopped out; waits for the signal to change
    position_id BIGINT,
    note        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS paper_agent_log (
    id      BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind    TEXT NOT NULL,
    message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_agent_log_user_idx ON paper_agent_log (user_id, id DESC);

ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS agent BOOLEAN NOT NULL DEFAULT false;

-- The latest past test and its diagnosis, for the AI coach to read.
CREATE TABLE IF NOT EXISTS agent_analyses (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    result     JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custom_strategies (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rules      JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS custom_strategies_user ON custom_strategies (user_id, updated_at DESC);

-- Price alerts: checked while the site is open, against every minute bar since the alert was set.
CREATE TABLE IF NOT EXISTS price_alerts (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    price           DOUBLE PRECISION NOT NULL CHECK (price > 0),
    direction       TEXT NOT NULL CHECK (direction IN ('above', 'below')),
    note            TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    triggered_at    TIMESTAMPTZ,
    triggered_price DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS price_alerts_user_idx ON price_alerts (user_id, triggered_at);

-- Weekly replay challenge: one stretch of candles per ISO week, the same for everyone.
CREATE TABLE IF NOT EXISTS challenges (
    week     TEXT PRIMARY KEY,               -- e.g. 2026-W45
    tf       TEXT NOT NULL,
    start_ts BIGINT NOT NULL,
    end_ts   BIGINT NOT NULL
);

-- One go per user per week. Shown on the leaderboard only when public, under a nickname.
CREATE TABLE IF NOT EXISTS challenge_entries (
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week             TEXT NOT NULL,
    return_pct       DOUBLE PRECISION NOT NULL,
    max_drawdown_pct DOUBLE PRECISION NOT NULL,
    trades           INTEGER NOT NULL,
    wins             INTEGER NOT NULL,
    public           BOOLEAN NOT NULL DEFAULT false,
    nickname         TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, week)
);
CREATE INDEX IF NOT EXISTS challenge_entries_week_idx ON challenge_entries (week, return_pct DESC);

-- A review of each closed paper trade, written once and kept. source is 'ai' or 'checklist'.
CREATE TABLE IF NOT EXISTS trade_reviews (
    position_id BIGINT PRIMARY KEY REFERENCES paper_positions(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    review      JSONB NOT NULL,
    source      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_reviews_user_idx ON trade_reviews (user_id, created_at);

-- Lessons on the learning path that the user has finished, with how their replay went.
CREATE TABLE IF NOT EXISTS lesson_progress (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson       TEXT NOT NULL,
    return_pct   DOUBLE PRECISION NOT NULL,
    trades       INTEGER NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, lesson)
);

-- Per-account settings that follow the user across devices (chart drawings, indicators).
CREATE TABLE IF NOT EXISTS user_prefs (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

-- Markets beyond gold: every paper order and position belongs to one market (see app/instruments.py).
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS symbol TEXT NOT NULL DEFAULT 'XAUUSD';
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS symbol TEXT NOT NULL DEFAULT 'XAUUSD';

-- Broker-style order handling: a trailing stop follows the price by a fixed distance; one-cancels-other
-- pairs two pending orders so that when one fills the other is cancelled.
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS trail DOUBLE PRECISION;
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS trailed_at TIMESTAMPTZ;  -- bar that last moved the trailing stop
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS trail DOUBLE PRECISION;
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS oco_id BIGINT;

-- AI coach: a stop moved further away while the trade was open, the user's own pre-trade playbook,
-- and the weekly coach report, written once a week has ended.
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS stop_widened BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS coach_reports (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week       TEXT NOT NULL,                      -- ISO week, e.g. 2026-W45
    report     JSONB NOT NULL,
    source     TEXT NOT NULL,                      -- 'ai' or 'rules'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, week)
);

-- Realistic fills (app/fills.py): wider spreads and stop slippage around big releases and the daily rollover.
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS realistic_fills BOOLEAN NOT NULL DEFAULT true;

-- Prop challenges: evaluation rules (profit target, daily and overall loss limits, minimum trading days)
-- run on the paper account. paper_accounts.challenge_id is the challenge the account is in, if any.
CREATE TABLE IF NOT EXISTS prop_challenges (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan              TEXT NOT NULL,
    size              DOUBLE PRECISION NOT NULL,
    leverage          INTEGER NOT NULL,
    rules             JSONB NOT NULL,                 -- targets per phase, daily_loss_pct, max_loss_pct, min_days
    phase             SMALLINT NOT NULL DEFAULT 1,
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'passed', 'failed', 'abandoned')),
    phase_started_at  TIMESTAMPTZ NOT NULL,
    day               DATE,                           -- current trading day (17:00 New York rollover)
    day_start_balance DOUBLE PRECISION NOT NULL,
    min_equity        DOUBLE PRECISION,
    worst_daily_pct   DOUBLE PRECISION NOT NULL DEFAULT 0,
    fail_rule         TEXT,
    fail_detail       TEXT,
    phase_results     JSONB NOT NULL DEFAULT '[]',
    final             JSONB,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS prop_challenges_user_idx ON prop_challenges (user_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS prop_challenges_active_idx ON prop_challenges (user_id) WHERE status = 'active';
ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS challenge_id BIGINT;

-- Manual backtesting sessions (app/sessions.py): a replay over any range, paused and resumed from saved state.
CREATE TABLE IF NOT EXISTS replay_sessions (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT '',
    tf         TEXT NOT NULL,
    start_at   TIMESTAMPTZ NOT NULL,
    end_at     TIMESTAMPTZ NOT NULL,
    blind      BOOLEAN NOT NULL DEFAULT false,
    state      JSONB,                              -- candles shown, trades, open trade, ticket settings
    finished   BOOLEAN NOT NULL DEFAULT false,
    result     JSONB,                              -- the server's settlement once finished
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replay_sessions_user_idx ON replay_sessions (user_id, updated_at DESC);

-- Daily Candle (app/daily.py): one hidden moment of gold history a day, chosen once and kept.
CREATE TABLE IF NOT EXISTS daily_candles (
    day       DATE PRIMARY KEY,
    symbol    TEXT NOT NULL,
    frozen_ts BIGINT NOT NULL                     -- the last hourly bar shown before the choice
);

-- One answer per signed-in player per day, for the streak and the crowd split.
CREATE TABLE IF NOT EXISTS daily_candle_plays (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day        DATE NOT NULL,
    choice     TEXT NOT NULL CHECK (choice IN ('buy', 'sell', 'wait')),
    correct    BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS daily_candle_plays_day_idx ON daily_candle_plays (day);
