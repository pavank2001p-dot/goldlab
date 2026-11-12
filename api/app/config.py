import os
from datetime import date


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://gold:gold@localhost:5432/gold")
JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-secret-change-me-before-deploying")
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "30"))
# Cookies must be Secure in production (HTTPS); local dev runs on plain http.
COOKIE_SECURE = _bool("COOKIE_SECURE", False)
# Price source for scheduled updates: "dukascopy" (real) or "sample" (offline demo data).
PRICE_SOURCE = os.getenv("PRICE_SOURCE", "dukascopy")
# Run the price updater inside the API process (one Railway service, no separate cron).
ENABLE_SCHEDULER = _bool("ENABLE_SCHEDULER", False)
UPDATE_INTERVAL_MIN = int(os.getenv("UPDATE_INTERVAL_MIN", "15"))
SYMBOL = "XAUUSD"
# Oldest hourly bar to fetch from Dukascopy, whose XAU/USD feed starts in 2003. Older years come
# from the bundled monthly history (since 1833) and show on the monthly chart only.
HISTORY_SINCE = date.fromisoformat(os.getenv("HISTORY_SINCE", "2003-05-01"))
# Short-timeframe history kept for the chart: minute bars and one-second bars.
MINUTE_DAYS = int(os.getenv("MINUTE_DAYS", "60"))
# Markets other than gold keep fewer minute bars: they take most of the database (one row a minute each).
MARKET_MINUTE_DAYS = int(os.getenv("MARKET_MINUTE_DAYS", "14"))
SECOND_DAYS = int(os.getenv("SECOND_DAYS", "2"))
# Markets other than gold: hourly history from this date (their feed mostly starts around 2017
# for stocks), and which symbols also keep one-second bars (they take the most space).
MARKET_HISTORY_SINCE = date.fromisoformat(os.getenv("MARKET_HISTORY_SINCE", "2015-01-01"))
SECOND_SYMBOLS = {s.strip().upper() for s in os.getenv("SECOND_SYMBOLS", "XAUUSD").split(",") if s.strip()}

# Week 3: news and calendar. Both features stay quiet (empty, no errors) until keys are set.
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
NEWS_MODEL = os.getenv("NEWS_MODEL", "claude-opus-5-5")
# Stream live quotes from Finnhub's websocket (needs FINNHUB_API_KEY and ENABLE_SCHEDULER).
LIVE_PRICES = _bool("LIVE_PRICES", True)
NEWS_INTERVAL_MIN = int(os.getenv("NEWS_INTERVAL_MIN", "30"))
# Free weekly calendar feed (ForexFactory's public JSON). Set to "" to rely on the seeded Fed dates only.
CALENDAR_FEED_URL = os.getenv("CALENDAR_FEED_URL", "https://nfs.faireconomy.media/ff_calendar_thisweek.json")

# Week 4: AI assistant. Uses ANTHROPIC_API_KEY; each user gets a fixed number of questions per UTC day.
ASSISTANT_MODEL = os.getenv("ASSISTANT_MODEL", "claude-opus-5-5")
ASSISTANT_DAILY_LIMIT = int(os.getenv("ASSISTANT_DAILY_LIMIT", "20"))

if COOKIE_SECURE and JWT_SECRET.startswith("dev-only"):
    raise RuntimeError("Set JWT_SECRET to a long random value in production")
