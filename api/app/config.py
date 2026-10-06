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

if COOKIE_SECURE and JWT_SECRET.startswith("dev-only"):
    raise RuntimeError("Set JWT_SECRET to a long random value in production")
