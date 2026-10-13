CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per bar. tf is '1h' or '1d'; ts is the bar's open time in UTC.
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
