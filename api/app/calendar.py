"""US economic calendar: the events that tend to move gold (Fed decisions, inflation, jobs, growth)."""

import logging
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Query

from . import config, db

log = logging.getLogger("calendar")
router = APIRouter(prefix="/calendar", tags=["calendar"])

# FOMC rate decisions for 2026 (second day of each meeting, statement at 14:00 New York = 18:00/19:00 UTC).
# Source: Federal Reserve meeting calendar. Re-check against federalreserve.gov each December.
FOMC_2026 = ["2026-01-28T19:00", "2026-03-18T18:00", "2026-04-29T18:00", "2026-06-17T18:00",
             "2026-07-29T18:00", "2026-09-16T18:00", "2026-10-28T18:00", "2026-12-09T19:00"]

# Why each kind of release matters for gold, shown next to the event.
EXPLAIN = [
    (("fomc", "federal funds", "fed chair", "powell", "interest rate decision"),
     "Sets US interest rates. Signals of cuts usually help gold; signals of hikes usually weigh on it."),
    (("cpi", "pce", "ppi", "inflation"),
     "Measures inflation. Hotter numbers can mean higher rates for longer, often a headwind for gold in the short run."),
    (("non-farm", "nonfarm", "payroll", "unemployment", "jobless"),
     "Shows the job market's strength. Strong jobs data can lift the dollar and yields and pressure gold."),
    (("gdp", "retail sales", "ism", "pmi"),
     "Measures economic growth. Weak growth raises rate-cut hopes, which tends to support gold."),
]


def why(title: str) -> str:
    t = title.lower()
    return next((text for keys, text in EXPLAIN if any(k in t for k in keys)), "")


def seed_fomc() -> None:
    rows = [(datetime.fromisoformat(d).replace(tzinfo=timezone.utc), "FOMC rate decision") for d in FOMC_2026]
    with db.conn() as c, c.cursor() as cur:
        cur.executemany(
            """INSERT INTO events (ts, country, title, impact, source) VALUES (%s, 'USD', %s, 'High', 'federalreserve.gov')
               ON CONFLICT (title, ts) DO NOTHING""",
            rows,
        )


def fetch_feed() -> int:
    """Pull this week's USD high/medium-impact events from the public calendar feed."""
    if not config.CALENDAR_FEED_URL:
        return 0
    r = httpx.get(config.CALENDAR_FEED_URL, timeout=20, headers={"User-Agent": "goldlab/1.0"})
    r.raise_for_status()
    rows = []
    for e in r.json():
        if e.get("country") != "USD" or e.get("impact") not in ("High", "Medium"):
            continue
        try:
            ts = datetime.fromisoformat(e["date"]).astimezone(timezone.utc)
        except (KeyError, ValueError):
            continue
        rows.append((ts, e["title"][:200], e["impact"], e.get("forecast") or "", e.get("previous") or ""))
    with db.conn() as c, c.cursor() as cur:
        cur.executemany(
            """INSERT INTO events (ts, country, title, impact, forecast, previous, source)
               VALUES (%s, 'USD', %s, %s, %s, %s, 'forexfactory')
               ON CONFLICT (title, ts) DO UPDATE SET impact = EXCLUDED.impact,
                 forecast = EXCLUDED.forecast, previous = EXCLUDED.previous""",
            rows,
        )
    return len(rows)


def update() -> int:
    seed_fomc()
    try:
        return fetch_feed()
    except httpx.HTTPError as e:
        log.warning("calendar feed failed: %s", e)
        return 0


@router.get("")
def list_(days: int = Query(14, ge=1, le=90), past_days: int = Query(2, ge=0, le=30)):
    now = datetime.now(timezone.utc)
    with db.conn() as c:
        rows = c.execute(
            """SELECT id, ts, country, title, impact, forecast, previous, source FROM events
               WHERE ts >= %s AND ts < %s ORDER BY ts""",
            (now - timedelta(days=past_days), now + timedelta(days=days)),
        ).fetchall()
    return [{**r, "why": why(r["title"])} for r in rows]
