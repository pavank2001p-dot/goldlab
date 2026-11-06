from datetime import datetime, timedelta, timezone

from app import config, db, review
from app.review import checklist


def signup(client, email="v@example.com"):
    assert client.post("/auth/signup", json={"email": email, "password": "longenough"}).status_code == 201
    with db.conn() as c:
        return c.execute("SELECT id FROM users WHERE email = %s", (email,)).fetchone()["id"]


def position(uid, closed=True, stop=1990.0, target=2030.0, pnl=-100.0):
    t = datetime(2025, 3, 3, 12, tzinfo=timezone.utc)
    with db.conn() as c:
        c.execute("INSERT INTO paper_accounts (user_id, starting_balance, balance) VALUES (%s, 10000, 10000) "
                  "ON CONFLICT DO NOTHING", (uid,))
        return c.execute(
            "INSERT INTO paper_positions (user_id, side, units, entry_price, opened_at, stop_loss, take_profit, closed_at, "
            "exit_price, close_reason, pnl) VALUES (%s, 'long', 10, 2000, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (uid, t, stop, target, t + timedelta(hours=2) if closed else None, 1990 if closed else None,
             "stop_loss" if closed else None, pnl if closed else None)).fetchone()["id"]


BASE = {"stop_loss": 1990, "risked_pct": 1.0, "risk_limit_pct": 1.0, "planned_reward_to_risk": 3.0,
        "how_it_ended": "hit its stop loss", "with_trend": True, "trend_before_entry": "up",
        "big_release_within_3h": []}


def test_checklist_grades_process_not_result():
    grade, good, work, _ = checklist(BASE)
    assert grade == "A" and len(good) == 3 and not work
    grade, _, work, habit = checklist({**BASE, "stop_loss": None, "risked_pct": None, "planned_reward_to_risk": None,
                                       "with_trend": False, "trend_before_entry": "down"})
    assert grade == "D" and "no stop loss" in work[0] and "stop" in habit
    grade, _, work, _ = checklist({**BASE, "risked_pct": 4.0, "big_release_within_3h": ["CPI"]})
    assert grade == "B" and any("above your" in w for w in work) and any("CPI" in w for w in work)


def test_review_needs_closed_trade_and_is_kept(client, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "")
    uid = signup(client)
    open_id = position(uid, closed=False)
    assert client.post(f"/practice/reviews/{open_id}").status_code == 409
    pid = position(uid)
    r = client.post(f"/practice/reviews/{pid}").json()
    assert r["source"] == "checklist" and r["grade"] in "ABCD"
    assert r["facts"]["how_it_ended"] == "hit its stop loss"
    assert r["facts"]["risked"] == 100 and r["facts"]["planned_reward_to_risk"] == 3 and r["facts"]["result_in_r"] == -1
    calls = []
    monkeypatch.setattr(review, "_ai", lambda *a: calls.append(a))
    assert client.post(f"/practice/reviews/{pid}").json()["headline"] == r["headline"]
    assert not calls
    assert client.get("/practice/reviews").json() == {str(pid): r["grade"]}
    signup(client, "other@example.com")
    assert client.post(f"/practice/reviews/{pid}").status_code == 404


def test_review_uses_ai_when_available(client, monkeypatch):
    uid = signup(client)
    pid = position(uid)
    monkeypatch.setattr(review, "_ai", lambda f, g: {"grade": "B", "headline": "Good plan.", "went_well": ["Stop set."],
                                                      "work_on": [], "next_time": "Keep it up."})
    r = client.post(f"/practice/reviews/{pid}").json()
    assert r["source"] == "ai" and r["headline"] == "Good plan." and r["checklist_grade"] in "ABCD"


def test_lessons_and_progress(client):
    lessons = client.get("/learn").json()
    assert len(lessons) >= 5 and all("body" not in l for l in lessons)
    one = client.get(f"/learn/{lessons[0]['id']}").json()
    assert one["body"] and one["next"] == lessons[1]["id"]
    assert client.get("/learn/nope").status_code == 404
    assert client.get("/learn/progress").status_code == 401
    signup(client)
    assert client.get("/learn/progress").json() == {}
    done = client.post(f"/learn/{lessons[0]['id']}/complete", json={"return_pct": 1.234, "trades": 3}).json()
    assert done[lessons[0]["id"]]["return_pct"] == 1.23
    done = client.post(f"/learn/{lessons[0]['id']}/complete", json={"return_pct": -2, "trades": 1}).json()
    assert done[lessons[0]["id"]]["trades"] == 1 and len(done) == 1
    assert client.post("/learn/nope/complete", json={"return_pct": 0, "trades": 0}).status_code == 404
