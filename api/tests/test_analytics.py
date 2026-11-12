from datetime import datetime, timedelta, timezone

from app import analytics, config, db


def signup(client, email):
    r = client.post("/auth/signup", json={"email": email, "password": "longenough"})
    assert r.status_code == 201
    return r.json()["id"]


def test_source_and_path_cleaning():
    assert analytics.source_of("https://www.google.com/search?q=x") == "search"
    assert analytics.source_of("https://t.co/abc") == "social"
    assert analytics.source_of("https://old.reddit.com/r/gold") == "social"
    assert analytics.source_of("https://example.org/") == "other"
    assert analytics.source_of(None) == "direct"
    assert analytics.source_of("https://lab.example.com/chart", "lab.example.com:443") == "internal"
    assert analytics.clean_path("/gold-trading-simulator?utm=x") == "/gold-trading-simulator"
    assert analytics.clean_path("/paper/sessions/123") == "/paper/sessions/:id"
    assert analytics.clean_path("//chart//") == "/chart"


def test_page_views_are_counted_without_user(client):
    for ref in ("https://www.google.com/", "https://www.bing.com/", None):
        assert client.post("/analytics/view", json={"path": "/xauusd-backtest", "referrer": ref}).status_code == 204
    with db.conn() as c:
        rows = c.execute("SELECT source, views FROM page_views WHERE path = '/xauusd-backtest' ORDER BY source").fetchall()
    assert [(r["source"], r["views"]) for r in rows] == [("direct", 1), ("search", 2)]


def test_funnel_is_admin_only_and_counts_cohorts(client, monkeypatch):
    analytics.reset_cache()
    a = signup(client, "a@example.com")
    client.post("/auth/logout")
    b = signup(client, "boss@example.com")
    now = datetime.now(timezone.utc)
    with db.conn() as c:
        # A signed up three weeks ago, traded the same day and came back on day 9.
        c.execute("UPDATE users SET created_at = %s WHERE id = %s", (now - timedelta(days=21), a))
        c.execute("""INSERT INTO paper_positions (user_id, side, units, entry_price, opened_at)
                     VALUES (%s, 'long', 1, 4000, %s)""", (a, now - timedelta(days=21) + timedelta(hours=2)))
        c.execute("INSERT INTO user_activity (user_id, day) VALUES (%s, %s)", (a, (now - timedelta(days=12)).date()))
    assert client.get("/analytics/funnel").status_code == 403
    monkeypatch.setattr(config, "ADMIN_EMAILS", {"boss@example.com"})
    client.post("/analytics/view", json={"path": "/gold-trading-simulator", "referrer": "https://google.com"})
    body = client.get("/analytics/funnel?weeks=5").json()
    t = body["totals"]
    assert t["signups"] == 2 and t["first_trade"] == 1 and t["first_trade_day1"] == 1
    # Only A is old enough for the day-7 check, and A came back.
    assert t["day7_eligible"] == 1 and t["day7_returned"] == 1 and t["day7_pct"] == 100.0
    # The admin's own requests today count as activity.
    assert body["active"]["today"] >= 1
    assert body["pages"][0]["path"] == "/gold-trading-simulator" and body["pages"][0]["search"] == 1
    assert len(body["cohorts"]) == 5
    analytics.reset_cache()
