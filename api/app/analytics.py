"""First-party product analytics: the sign-up funnel and which pages bring people in.

Tracks three things the improvement plan asked for: sign-ups, each account's first paper trade, and
whether people come back in their second week (the day-7 return). Activity is one row per user per
day, written at most once a day per process. Page views are counts per day, page and referrer kind;
no IP address, cookie or user id is stored with them.
"""

from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import config, db
from .auth import UserOut, current_user

router = APIRouter(prefix="/analytics", tags=["analytics"])

SEARCH = ("google.", "bing.", "duckduckgo.", "yahoo.", "yandex.", "baidu.", "ecosia.", "brave.")
SOCIAL = ("t.co", "twitter.", "x.com", "facebook.", "instagram.", "linkedin.", "reddit.", "youtube.",
          "whatsapp.", "telegram.", "t.me", "tiktok.", "discord.")

_seen: set[tuple[int, date]] = set()


def touch(user_id: int) -> None:
    """Note that this user used the site today."""
    today = datetime.now(timezone.utc).date()
    if (user_id, today) in _seen:
        return
    with db.conn() as c:
        c.execute("INSERT INTO user_activity (user_id, day) VALUES (%s, %s) ON CONFLICT DO NOTHING", (user_id, today))
    if len(_seen) > 50_000:
        _seen.clear()
    _seen.add((user_id, today))


def reset_cache():
    _seen.clear()


def source_of(referrer: str | None, own_host: str | None = None) -> str:
    host = (urlparse(referrer or "").hostname or "").lower()
    if own_host and host == own_host.lower().split(":")[0]:
        return "internal"
    if not host:
        return "direct"
    if any(s in host for s in SEARCH):
        return "search"
    if any(host == s or host.endswith("." + s) or s in host for s in SOCIAL):
        return "social"
    return "other"


def clean_path(path: str) -> str:
    p = path.split("?")[0].split("#")[0]
    p = "/" + "/".join(s for s in p.split("/") if s)
    # Ids in paths (shared reports, sessions) would make every page unique; count them as one.
    p = "/".join(":id" if s.isdigit() or (len(s) > 16 and any(ch.isdigit() for ch in s)) else s for s in p.split("/"))
    return p[:100] or "/"


class ViewIn(BaseModel):
    path: str = Field(max_length=500)
    referrer: str | None = Field(default=None, max_length=1000)
    host: str | None = Field(default=None, max_length=200)


@router.post("/view", status_code=204)
def view(body: ViewIn):
    today = datetime.now(timezone.utc).date()
    with db.conn() as c:
        c.execute(
            """INSERT INTO page_views (day, path, source, views) VALUES (%s, %s, %s, 1)
               ON CONFLICT (day, path, source) DO UPDATE SET views = page_views.views + 1""",
            (today, clean_path(body.path), source_of(body.referrer, body.host)),
        )


def admin(user: UserOut = Depends(current_user)) -> UserOut:
    if user.email.lower() not in config.ADMIN_EMAILS:
        raise HTTPException(403, "Only the site's admins can see product metrics")
    return user


def _pct(n: int, d: int) -> float | None:
    return round(100 * n / d, 1) if d else None


@router.get("/funnel")
def funnel(weeks: int = Query(8, ge=1, le=52), days: int = Query(30, ge=1, le=365), _: UserOut = Depends(admin)):
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=today.weekday()) - timedelta(weeks=weeks - 1)
    with db.conn() as c:
        rows = c.execute(
            """SELECT date_trunc('week', u.created_at AT TIME ZONE 'UTC')::date AS week,
                      count(*) AS signups,
                      count(f.first) AS traded,
                      count(*) FILTER (WHERE f.first < u.created_at + interval '1 day') AS traded_day1,
                      count(*) FILTER (WHERE (u.created_at AT TIME ZONE 'UTC')::date + 7 <= %(today)s) AS day7_eligible,
                      count(*) FILTER (WHERE EXISTS (
                          SELECT 1 FROM user_activity a WHERE a.user_id = u.id
                            AND a.day >= (u.created_at AT TIME ZONE 'UTC')::date + 7
                            AND a.day <  (u.created_at AT TIME ZONE 'UTC')::date + 14)) AS day7_returned
               FROM users u
               LEFT JOIN LATERAL (SELECT min(opened_at) AS first FROM paper_positions p WHERE p.user_id = u.id) f ON true
               WHERE u.created_at >= %(start)s
               GROUP BY 1 ORDER BY 1""",
            {"today": today, "start": start},
        ).fetchall()
        active = c.execute(
            """SELECT count(DISTINCT user_id) FILTER (WHERE day = %(today)s) AS today,
                      count(DISTINCT user_id) FILTER (WHERE day > %(today)s - 7) AS week,
                      count(DISTINCT user_id) FILTER (WHERE day > %(today)s - 30) AS month
               FROM user_activity WHERE day > %(today)s - 30""",
            {"today": today},
        ).fetchone()
        pages = c.execute(
            """SELECT path, sum(views)::int AS views,
                      COALESCE(sum(views) FILTER (WHERE source = 'search'), 0)::int AS search,
                      COALESCE(sum(views) FILTER (WHERE source = 'social'), 0)::int AS social,
                      COALESCE(sum(views) FILTER (WHERE source = 'other'), 0)::int AS other,
                      COALESCE(sum(views) FILTER (WHERE source = 'direct'), 0)::int AS direct,
                      COALESCE(sum(views) FILTER (WHERE source = 'internal'), 0)::int AS internal
               FROM page_views WHERE day > %s GROUP BY path ORDER BY views DESC LIMIT 40""",
            (today - timedelta(days=days),),
        ).fetchall()
    by_week = {r["week"]: r for r in rows}
    cohorts = []
    for i in range(weeks):
        wk = start + timedelta(weeks=i)
        r = by_week.get(wk) or {"signups": 0, "traded": 0, "traded_day1": 0, "day7_eligible": 0, "day7_returned": 0}
        cohorts.append({
            "week": wk.isoformat(),
            "signups": r["signups"],
            "first_trade": r["traded"],
            "first_trade_pct": _pct(r["traded"], r["signups"]),
            "first_trade_day1": r["traded_day1"],
            "day7_eligible": r["day7_eligible"],
            "day7_returned": r["day7_returned"],
            "day7_pct": _pct(r["day7_returned"], r["day7_eligible"]),
        })
    tot = {k: sum(c[k] for c in cohorts) for k in ("signups", "first_trade", "first_trade_day1", "day7_eligible", "day7_returned")}
    tot["first_trade_pct"] = _pct(tot["first_trade"], tot["signups"])
    tot["day7_pct"] = _pct(tot["day7_returned"], tot["day7_eligible"])
    return {"cohorts": cohorts, "totals": tot, "active": active, "pages": pages, "page_days": days}
