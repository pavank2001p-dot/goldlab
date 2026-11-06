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


# ---------------------------------------------------------------------------
# Chart markers: scheduled releases from the calendar, plus a short list of turning points
# from gold's recent history, so a chart shows what was happening when the price moved.
# ---------------------------------------------------------------------------

# (UTC date, title, kind). Kinds: fed, inflation, jobs, growth, dollar, shock.
HISTORY = [
    ("2008-03-16", "Bear Stearns rescued by JPMorgan", "shock"),
    ("2008-09-15", "Lehman Brothers files for bankruptcy", "shock"),
    ("2008-11-25", "Fed announces its first bond-buying programme (QE1)", "fed"),
    ("2008-12-16", "Fed cuts rates to near zero", "fed"),
    ("2010-11-03", "Fed launches QE2", "fed"),
    ("2011-08-05", "S&P downgrades the US credit rating", "shock"),
    ("2011-09-06", "Swiss central bank caps the franc; gold near its 2011 peak", "dollar"),
    ("2012-09-13", "Fed launches open-ended QE3", "fed"),
    ("2013-04-15", "Gold's sharpest one-day fall in decades", "shock"),
    ("2013-05-22", "Fed chair Bernanke hints at slowing bond buying", "fed"),
    ("2013-12-18", "Fed starts tapering bond purchases", "fed"),
    ("2015-01-15", "Swiss central bank drops the franc cap", "dollar"),
    ("2015-12-16", "Fed raises rates for the first time since 2006", "fed"),
    ("2016-06-24", "UK votes to leave the EU", "shock"),
    ("2016-11-09", "US election result", "shock"),
    ("2019-07-31", "Fed's first rate cut since 2008", "fed"),
    ("2020-03-03", "Fed makes an emergency half-point cut", "fed"),
    ("2020-03-15", "Fed cuts rates to near zero", "fed"),
    ("2020-03-23", "Fed promises unlimited bond buying", "fed"),
    ("2020-08-06", "Gold sets a record above $2,000", "shock"),
    ("2021-11-10", "US inflation hits 6.2%, a 30-year high", "inflation"),
    ("2022-02-24", "Russia invades Ukraine", "shock"),
    ("2022-03-16", "Fed's first hike of the 2022 cycle", "fed"),
    ("2022-06-10", "US inflation hits 8.6%", "inflation"),
    ("2022-06-15", "Fed hikes by three quarters of a point", "fed"),
    ("2022-09-28", "US dollar index at a 20-year high", "dollar"),
    ("2023-03-10", "Silicon Valley Bank collapses", "shock"),
    ("2023-07-26", "Fed's last hike of the cycle", "fed"),
    ("2024-09-18", "Fed's first cut in four years, half a point", "fed"),
    ("2025-04-02", "US announces sweeping tariffs", "shock"),
]

WHY_KIND = {
    "fed": "Fed decisions change interest rates and the dollar, two of the biggest drivers of gold.",
    "inflation": "Inflation data shapes where rates go next, which moves gold.",
    "jobs": "Jobs data moves rate expectations and the dollar, and gold with them.",
    "growth": "Growth data shifts rate-cut hopes, which tends to move gold.",
    "dollar": "Gold is priced in dollars, so big currency moves show up in its price.",
    "shock": "Market shocks often send investors toward gold, or force them to sell it for cash.",
}


def kind_of(title: str) -> str:
    t = title.lower()
    for kind, keys in (("fed", ("fomc", "federal funds", "fed chair", "powell", "interest rate")),
                       ("inflation", ("cpi", "pce", "ppi", "inflation")),
                       ("jobs", ("non-farm", "nonfarm", "payroll", "unemployment", "jobless")),
                       ("growth", ("gdp", "retail sales", "ism", "pmi"))):
        if any(k in t for k in keys):
            return kind
    return "other"


@router.get("/markers")
def markers(start: int = Query(..., description="Unix seconds"), end: int = Query(...),
            scheduled: bool = Query(True, description="Include calendar releases, not only turning points")):
    """Events between start and end for marking on a chart, oldest first."""
    a = datetime.fromtimestamp(start, tz=timezone.utc)
    b = datetime.fromtimestamp(end, tz=timezone.utc)
    out = []
    for d, title, kind in HISTORY:
        ts = datetime.fromisoformat(d).replace(tzinfo=timezone.utc)
        if a <= ts < b:
            out.append({"t": int(ts.timestamp()), "title": title, "kind": kind, "impact": "High",
                        "why": WHY_KIND[kind], "history": True})
    if scheduled:
        with db.conn() as c:
            rows = c.execute("SELECT ts, title, impact FROM events WHERE ts >= %s AND ts < %s AND impact = 'High' "
                             "ORDER BY ts LIMIT 2000", (a, b)).fetchall()
        for r in rows:
            k = kind_of(r["title"])
            out.append({"t": int(r["ts"].timestamp()), "title": r["title"], "kind": k, "impact": r["impact"],
                        "why": why(r["title"]) or WHY_KIND.get(k, ""), "history": False})
    out.sort(key=lambda e: e["t"])
    return out
