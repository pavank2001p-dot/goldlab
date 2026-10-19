import os


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

# Week 3: news and calendar. Both features stay quiet (empty, no errors) until keys are set.
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
NEWS_MODEL = os.getenv("NEWS_MODEL", "claude-opus-5-5")
NEWS_INTERVAL_MIN = int(os.getenv("NEWS_INTERVAL_MIN", "30"))
# Free weekly calendar feed (ForexFactory's public JSON). Set to "" to rely on the seeded Fed dates only.
CALENDAR_FEED_URL = os.getenv("CALENDAR_FEED_URL", "https://nfs.faireconomy.media/ff_calendar_thisweek.json")

if COOKIE_SECURE and JWT_SECRET.startswith("dev-only"):
    raise RuntimeError("Set JWT_SECRET to a long random value in production")
