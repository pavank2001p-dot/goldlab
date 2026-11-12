"""The AI coach: joins trade reviews, habit insights and the assistant into one coach on the user's own trades.

Three parts:
- Mistake tags on every closed paper trade, worked out by rules from data already stored: no stop, a stop
  moved further away, a quick trade after a loss (revenge), risk above the profile's limit (oversized),
  opened near a high-impact release (red-folder event), and a margin stop-out.
- A pre-trade check: the user's own playbook rules (saved per account) plus warnings worked out now,
  such as a loss in the last half hour or a big release coming up.
- A weekly report: the week's trades, tags against the week before, the best habit and the one thing to
  work on. Claude writes it from those numbers when the assistant is set up; otherwise plain rules do.
  A finished week's report is saved and not rewritten.

Like the trade reviews, it grades process, never profit, and never says where prices will go."""

import json
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from . import config, db
from .auth import UserOut, current_user
from .risk import profile_of

router = APIRouter(prefix="/coach", tags=["coach"])

REVENGE_MIN = 30          # a trade opened this soon after a losing one is tagged
EVENT_WINDOW_MIN = 30     # a trade opened this close to a high-impact release is tagged
MAX_RULES = 12
MAX_RULE_LEN = 140

TAGS = {
    "no_stop": ("No stop loss", "The trade had no stop loss, so the loss had no limit until you acted."),
    "stop_widened": ("Stop moved away", "The stop was moved further from the entry while the trade was open, "
                                        "giving a loser more room instead of accepting the planned loss."),
    "revenge": ("Revenge trade", f"Opened within {REVENGE_MIN} minutes of closing a losing trade."),
    "oversized": ("Oversized", "The stop would have cost more of the account than your risk limit allows."),
    "red_folder": ("Near a big release", f"Opened within {EVENT_WINDOW_MIN} minutes of a high-impact release, "
                                         "when prices can jump past stops."),
    "stop_out": ("Margin stop-out", "Closed by the margin stop-out, which means the account was too stretched."),
}
# The order tags are listed in, worst first, when one has to be picked as the thing to work on.
SEVERITY = ["stop_out", "no_stop", "stop_widened", "oversized", "revenge", "red_folder"]


def iso_week(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def week_bounds(week: str) -> tuple[datetime, datetime]:
    monday = date.fromisocalendar(int(week[:4]), int(week[6:]), 1)
    start = datetime(monday.year, monday.month, monday.day, tzinfo=timezone.utc)
    return start, start + timedelta(days=7)


def _limit(user_id: int) -> float:
    p = profile_of(user_id)
    return p["max_risk_per_trade_pct"] if p else 1.0


def tag_trades(c, user_id: int, until: datetime | None = None) -> list[dict]:
    """Every closed paper trade (oldest first) with its mistake tags."""
    rows = c.execute(
        "SELECT id, symbol, side, units, entry_price, opened_at, closed_at, stop_loss, close_reason, pnl, stop_widened "
        "FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL" + (" AND closed_at < %s" if until else "") +
        " ORDER BY opened_at, id", (user_id, until) if until else (user_id,)).fetchall()
    if not rows:
        return []
    acct = c.execute("SELECT starting_balance FROM paper_accounts WHERE user_id = %s", (user_id,)).fetchone()
    start_balance = acct["starting_balance"] if acct else 10_000.0
    lo, hi = rows[0]["opened_at"], rows[-1]["opened_at"]
    events = [e["ts"] for e in c.execute(
        "SELECT ts FROM events WHERE impact = 'High' AND ts BETWEEN %s AND %s ORDER BY ts",
        (lo - timedelta(minutes=EVENT_WINDOW_MIN), hi + timedelta(minutes=EVENT_WINDOW_MIN))).fetchall()]
    limit = _limit(user_id)
    by_close = sorted(rows, key=lambda r: r["closed_at"])
    out = []
    for r in rows:
        tags = []
        # A partial close books the first part as its own trade; both keep the position's stop history.
        if r["stop_loss"] is None:
            tags.append("no_stop")
        if r["stop_widened"]:
            tags.append("stop_widened")
        before = [q for q in by_close if q["closed_at"] <= r["opened_at"] and q["id"] != r["id"]]
        if before and (before[-1]["pnl"] or 0) < 0 and r["opened_at"] - before[-1]["closed_at"] <= timedelta(minutes=REVENGE_MIN):
            tags.append("revenge")
        equity = start_balance + sum(q["pnl"] or 0 for q in before)
        risk_pct = (abs(r["entry_price"] - r["stop_loss"]) * r["units"] / equity * 100
                    if r["stop_loss"] is not None and equity > 0 else None)
        if risk_pct is not None and risk_pct > limit * 1.05:
            tags.append("oversized")
        if any(abs((e - r["opened_at"]).total_seconds()) <= EVENT_WINDOW_MIN * 60 for e in events):
            tags.append("red_folder")
        if r["close_reason"] == "stop_out":
            tags.append("stop_out")
        out.append({"id": r["id"], "symbol": r["symbol"], "side": r["side"], "opened_at": r["opened_at"],
                    "closed_at": r["closed_at"], "pnl": round(r["pnl"] or 0, 2),
                    "risk_pct": None if risk_pct is None else round(risk_pct, 2), "tags": tags})
    return out


@router.get("/tags")
def tags(user: UserOut = Depends(current_user)):
    """Mistake tags by trade id, with what each tag means and how often it happened."""
    with db.conn() as c:
        trades = tag_trades(c, user.id)
    counts = {k: sum(k in t["tags"] for t in trades) for k in TAGS}
    return {"labels": {k: {"label": v[0], "explain": v[1]} for k, v in TAGS.items()},
            "by_trade": {str(t["id"]): t["tags"] for t in trades},
            "counts": counts, "trades": len(trades),
            "clean": sum(not t["tags"] for t in trades)}


# ---------------------------------------------------------------------------
# Playbook and the pre-trade check
# ---------------------------------------------------------------------------

DEFAULT_RULES = [
    "I know why I'm taking this trade, in one sentence.",
    "My stop is where the idea is proven wrong, not just a round number.",
    "The size comes from the stop, inside my risk limit.",
]


class PlaybookIn(BaseModel):
    rules: list[str] = Field(max_length=MAX_RULES)


def _playbook(c, user_id: int) -> list[str] | None:
    row = c.execute("SELECT value FROM user_prefs WHERE user_id = %s AND key = 'playbook'", (user_id,)).fetchone()
    return list(row["value"].get("rules", [])) if row and isinstance(row["value"], dict) else None


@router.get("/playbook")
def get_playbook(user: UserOut = Depends(current_user)):
    with db.conn() as c:
        rules = _playbook(c, user.id)
    return {"rules": DEFAULT_RULES if rules is None else rules, "custom": rules is not None, "max": MAX_RULES}


@router.put("/playbook")
def put_playbook(body: PlaybookIn, user: UserOut = Depends(current_user)):
    rules = [r.strip()[:MAX_RULE_LEN] for r in body.rules if r.strip()]
    with db.conn() as c:
        c.execute("INSERT INTO user_prefs (user_id, key, value) VALUES (%s, 'playbook', %s) "
                  "ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
                  (user.id, Jsonb({"rules": rules})))
    return {"rules": rules, "custom": True, "max": MAX_RULES}


@router.get("/pretrade")
def pretrade(user: UserOut = Depends(current_user)):
    """What to check before placing a trade right now: the playbook plus warnings from the user's own recent trades."""
    now = datetime.now(timezone.utc)
    with db.conn() as c:
        rules = _playbook(c, user.id)
        last = c.execute("SELECT closed_at, pnl FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL "
                         "ORDER BY closed_at DESC LIMIT 1", (user.id,)).fetchone()
        event = c.execute("SELECT title, ts FROM events WHERE impact = 'High' AND ts BETWEEN %s AND %s ORDER BY ts LIMIT 1",
                          (now - timedelta(minutes=EVENT_WINDOW_MIN), now + timedelta(minutes=EVENT_WINDOW_MIN))).fetchone()
        today = c.execute("SELECT count(*) AS n FROM paper_positions WHERE user_id = %s AND opened_at >= %s",
                          (user.id, now.replace(hour=0, minute=0, second=0, microsecond=0))).fetchone()["n"]
        typical = c.execute(
            "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS m FROM (SELECT count(*) AS n FROM paper_positions "
            "WHERE user_id = %s AND opened_at >= now() - interval '60 days' GROUP BY date_trunc('day', opened_at)) d",
            (user.id,)).fetchone()["m"]
    warnings = []
    if last and (last["pnl"] or 0) < 0 and now - last["closed_at"] <= timedelta(minutes=REVENGE_MIN):
        mins = max(round((now - last["closed_at"]).total_seconds() / 60), 1)
        warnings.append({"key": "revenge", "text": f"Your last trade lost {abs(last['pnl']):,.2f} {mins} min ago. "
                                                   "A short pause helps you trade the plan, not the loss."})
    if event:
        when = round((event["ts"] - now).total_seconds() / 60)
        warnings.append({"key": "red_folder", "text": f"{event['title']} is {'in ' + str(when) + ' min' if when > 0 else 'happening now'}"
                                                      ". Prices can jump past stops around big releases."})
    if typical and today >= max(2 * typical, 5):
        warnings.append({"key": "overtrading", "text": f"This is trade {today + 1} today, about twice your usual "
                                                       f"{typical:g}. Busy days are often the costly ones."})
    return {"rules": DEFAULT_RULES if rules is None else rules, "warnings": warnings, "risk_limit_pct": _limit(user.id)}


# ---------------------------------------------------------------------------
# Weekly report
# ---------------------------------------------------------------------------

REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "went_well": {"type": "array", "items": {"type": "string"}},
        "work_on": {"type": "string"},
        "next_week_goal": {"type": "string"},
    },
    "required": ["headline", "went_well", "work_on", "next_week_goal"],
    "additionalProperties": False,
}

SYSTEM = """You are a calm, encouraging trading coach on Trading Lab, a site where people practise trading gold
and other markets with virtual money. You write a short weekly report on ONE user's practice week from the facts
you are given: their trades, the mistake tags the rules found, and the week before for comparison.

Judge PROCESS, never profit: a week of small, well-planned losses beats a lucky week of oversized wins. Use only
the numbers in the facts and do not invent any. Write plain, friendly English for a beginner. Give a one-sentence
headline, one to three things that went well (each one short sentence), the single most important thing to work
on (one or two sentences, naming the tag and how often it happened), and one concrete, checkable goal for next week.

Never say where any market will go, never recommend buying or selling, and never give financial advice."""


def _week_facts(trades: list[dict], prev: list[dict]) -> dict:
    def summary(ts: list[dict]) -> dict:
        n = len(ts)
        return {"trades": n, "net": round(sum(t["pnl"] for t in ts), 2),
                "win_rate_pct": round(sum(t["pnl"] > 0 for t in ts) / n * 100) if n else None,
                "clean_trades": sum(not t["tags"] for t in ts),
                "tags": {k: c for k in TAGS if (c := sum(k in t["tags"] for t in ts))}}
    return {"this_week": summary(trades), "week_before": summary(prev),
            "tag_meanings": {k: v[1] for k, v in TAGS.items()}}


def _rules_report(f: dict) -> dict:
    w, p = f["this_week"], f["week_before"]
    if not w["trades"]:
        return {"headline": "No practice trades closed this week.", "went_well": [],
                "work_on": "Take a few small trades with a stop on each, so next week's report has something to coach.",
                "next_week_goal": "Close at least three paper trades, each with a stop loss set before it opens."}
    good = []
    if w["clean_trades"]:
        good.append(f"{w['clean_trades']} of {w['trades']} trades had no mistakes tagged.")
    if "no_stop" not in w["tags"]:
        good.append("Every trade had a stop loss.")
    if "oversized" not in w["tags"] and "no_stop" not in w["tags"]:
        good.append("Every trade risked no more than your limit.")
    for k in SEVERITY:
        if p["tags"].get(k, 0) > w["tags"].get(k, 0):
            good.append(f"Fewer '{TAGS[k][0].lower()}' trades than the week before ({w['tags'].get(k, 0)} against {p['tags'][k]}).")
            break
    worst = next((k for k in SEVERITY if w["tags"].get(k)), None)
    if worst:
        n = w["tags"][worst]
        work = f"{TAGS[worst][0]}: {n} trade{'s' if n != 1 else ''}. {TAGS[worst][1]}"
        goal = {
            "stop_out": "Keep the margin level above 300% all week by sizing every trade from its stop.",
            "no_stop": "Set a stop loss on every trade before it opens.",
            "stop_widened": "Never move a stop further away; close the trade or let the stop do its job.",
            "oversized": "Use the ticket's Risk % sizing on every trade so none goes over your limit.",
            "revenge": f"After any loss, wait {REVENGE_MIN} minutes before the next trade.",
            "red_folder": "Check the calendar first and stay flat for 30 minutes either side of high-impact releases.",
        }[worst]
    else:
        work, goal = ("Nothing was tagged. Keep the same routine and write one line on why you took each trade.",
                      "Repeat this week's process and add a short note to every trade.")
    clean_pct = round(w["clean_trades"] / w["trades"] * 100)
    net = f"{'-' if w['net'] < 0 else '+'}${abs(w['net']):,.2f}"
    headline = (f"{clean_pct}% of your {w['trades']} trade{'s' if w['trades'] != 1 else ''} had no mistakes tagged"
                + (f", with a net of {net}." if w["net"] else "."))
    return {"headline": headline, "went_well": good[:3], "work_on": work, "next_week_goal": goal}


def _ai_report(f: dict) -> dict | None:
    if not config.ANTHROPIC_API_KEY or not f["this_week"]["trades"]:
        return None
    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=2)
    try:
        resp = client.beta.messages.create(
            model=config.ASSISTANT_MODEL,
            max_tokens=2000,
            system=SYSTEM,
            messages=[{"role": "user", "content": "Write this week's coach report.\n\n" + json.dumps(f, default=str)}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": REPORT_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.APIError:
        return None
    if resp.stop_reason in ("refusal", "max_tokens"):
        return None
    try:
        return json.loads(next(b.text for b in resp.content if b.type == "text"))
    except (StopIteration, ValueError):
        return None


def weekly(user_id: int, week: str, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    start, end = week_bounds(week)
    if start > now:
        raise HTTPException(422, "That week hasn't started yet")
    finished = end <= now
    with db.conn() as c:
        if finished:
            have = c.execute("SELECT report, source, created_at FROM coach_reports WHERE user_id = %s AND week = %s",
                             (user_id, week)).fetchone()
            if have:
                return {**have["report"], "source": have["source"], "created_at": have["created_at"]}
        all_trades = tag_trades(c, user_id, until=min(end, now + timedelta(seconds=1)))
    this = [t for t in all_trades if start <= t["closed_at"] < end]
    prev = [t for t in all_trades if start - timedelta(days=7) <= t["closed_at"] < start]
    f = _week_facts(this, prev)
    # Claude writes finished weeks once; the week in progress uses the rules so it can refresh freely.
    ai = _ai_report(f) if finished else None
    out = {**(ai or _rules_report(f)), "week": week, "finished": finished, "facts": f,
           "trades": [{"id": t["id"], "symbol": t["symbol"], "side": t["side"], "pnl": t["pnl"], "tags": t["tags"],
                       "closed_at": t["closed_at"]} for t in this]}
    source = "ai" if ai else "rules"
    out = json.loads(json.dumps(out, default=str))
    if finished and this:
        with db.conn() as c:
            c.execute("INSERT INTO coach_reports (user_id, week, report, source) VALUES (%s, %s, %s, %s) "
                      "ON CONFLICT DO NOTHING", (user_id, week, Jsonb(out), source))
    return {**out, "source": source, "created_at": now.isoformat()}


@router.get("/weekly")
def get_weekly(week: str | None = Query(None, pattern=r"^\d{4}-W\d{2}$"), user: UserOut = Depends(current_user)):
    """The coach report for an ISO week (this week so far when left out)."""
    try:
        wk = week or iso_week(datetime.now(timezone.utc).date())
        week_bounds(wk)
    except ValueError:
        raise HTTPException(422, "Not a valid week")
    return weekly(user.id, wk)
