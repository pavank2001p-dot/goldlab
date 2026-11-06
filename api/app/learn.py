"""The learning path: short lessons on real moments in gold's history, each ending in a replay of that week.

A lesson explains what was going on and what to watch for, then the user trades the week on hourly
candles in the replay. Finishing a lesson is saved with the account. Lessons describe what happened;
they don't say what gold will do next."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import db
from .auth import UserOut, current_user

router = APIRouter(prefix="/learn", tags=["learn"])

LESSONS = [
    {
        "id": "2008-lehman", "year": 2008, "title": "When the banks broke", "day": "2008-09-15", "minutes": 6,
        "summary": "Lehman Brothers failed and markets panicked. Gold swung hard both ways in a single week.",
        "body": [
            "On Monday 15 September 2008, Lehman Brothers, one of Wall Street's biggest banks, filed for bankruptcy. "
            "Over the following days the US government rescued the insurer AIG and money markets froze.",
            "Gold is often called a safe haven, but in a panic people also sell whatever they can to raise cash. "
            "That week gold moved sharply down and then sharply up, sometimes by tens of dollars within hours.",
            "Moves like this punish trades without a stop and trades that are too big. Wide swings mean a sensible "
            "stop has to sit further away, so the position has to be smaller to risk the same amount.",
        ],
        "watch": ["How far the candles travel compared with a calm week", "Fast reversals that trap late entries",
                  "Whether your stop is wide enough for the swings"],
        "takeaway": "In a panic, size down. A wider stop with a smaller position risks the same money and survives the noise.",
    },
    {
        "id": "2011-peak", "year": 2011, "title": "The top nobody rang", "day": "2011-09-05", "minutes": 5,
        "summary": "After a ten-year rise, gold hit a record near $1,920 and then turned. Nobody knew it was the top.",
        "body": [
            "By September 2011 gold had risen for about a decade. In August the US lost its top credit rating, and in "
            "early September the price touched a record near $1,920 an ounce.",
            "On 6 September Switzerland capped its currency against the euro, and gold dropped back from the record "
            "within days. It would not reach that level again for years.",
            "Tops are only obvious afterwards. While it happens, a top looks like any other strong day. The lesson is "
            "not to guess the top, but to have an exit plan for when the trend stops behaving like a trend.",
        ],
        "watch": ["The excitement of new highs", "The first big down candle after the record",
                  "How quickly gains disappear without a stop or a target"],
        "takeaway": "Decide your exit before you enter. Chasing a market that is already at a record leaves little room for error.",
    },
    {
        "id": "2013-crash", "year": 2013, "title": "Two days in April", "day": "2013-04-09", "minutes": 5,
        "summary": "Gold fell around $200 over two sessions, one of its sharpest drops in decades.",
        "body": [
            "In spring 2013 investors were starting to expect less support from the Federal Reserve. On Friday 12 and "
            "Monday 15 April, gold fell around $200 an ounce, one of its largest two-day drops in decades.",
            "Falls like this often feed on themselves: stops are hit, which pushes the price lower, which hits more stops. "
            "Buying the dip felt cheap on Friday and was cheaper again on Monday.",
            "A falling market is not automatically a bargain. Waiting for the selling to calm down, with a clear stop, "
            "usually beats catching a falling knife.",
        ],
        "watch": ["Gaps between Friday's close and Monday's open", "Each bounce failing lower",
                  "The urge to buy because it 'can't fall further'"],
        "takeaway": "Never add to a losing trade to average down. Let the stop decide, then reassess calmly.",
    },
    {
        "id": "2020-covid", "year": 2020, "title": "Cash first, gold later", "day": "2020-03-09", "minutes": 6,
        "summary": "As Covid spread, investors sold almost everything, gold included, before the Fed stepped in.",
        "body": [
            "In March 2020 the pandemic hit markets everywhere. Shares crashed and even gold fell, because investors "
            "and funds needed cash to cover losses elsewhere.",
            "On Sunday 15 March the Fed cut interest rates to near zero in an emergency move, and a week later it "
            "promised to buy bonds without limit. Gold went on to reach a record that summer.",
            "This week shows that safe havens don't always rise in a crisis, at least not straight away. Events on a "
            "weekend can also open a new week far from Friday's price.",
        ],
        "watch": ["Gold falling with everything else", "Huge hourly ranges",
                  "The Sunday rate cut and how the new week opens"],
        "takeaway": "Don't hold a big position over a weekend in a crisis. A gap can jump right past your stop.",
    },
    {
        "id": "2020-record", "year": 2020, "title": "A record, then a drop", "day": "2020-08-05", "minutes": 4,
        "summary": "Gold broke above $2,000 for the first time, set a record, and then fell sharply days later.",
        "body": [
            "With interest rates near zero and governments spending heavily, gold climbed through the summer of 2020 "
            "and broke above $2,000 an ounce for the first time in early August.",
            "Days later, on 11 August, it fell sharply in a single session, wiping out a week of gains for anyone who "
            "had bought near the top.",
            "Round numbers like $2,000 attract attention and orders. They often bring fast moves in both directions, "
            "so they are a good place to be careful about where your stop sits.",
        ],
        "watch": ["Behaviour around the $2,000 level", "How the trend changes after the record",
                  "A long red candle after many green ones"],
        "takeaway": "Take some profit or tighten your stop as a move gets stretched. A record is a reason for care, not confidence.",
    },
    {
        "id": "2022-hikes", "year": 2022, "title": "Rates up, dollar up", "day": "2022-09-19", "minutes": 5,
        "summary": "The Fed raised rates by three quarters of a point again and the dollar hit a 20-year high.",
        "body": [
            "Through 2022 the Fed raised interest rates quickly to fight inflation. On 21 September it raised them by "
            "three quarters of a point for the third time in a row.",
            "Higher rates make holding gold, which pays no interest, less attractive, and they lifted the US dollar to a "
            "20-year high. Because gold is priced in dollars, a stronger dollar usually weighs on it.",
            "Big scheduled announcements are known in advance. Many traders avoid opening new positions just before them, "
            "because the price can jump in either direction in seconds.",
        ],
        "watch": ["Quiet trading before Wednesday's Fed decision", "The move straight after the announcement",
                  "A slow grind lower rather than a crash"],
        "takeaway": "Check the calendar before you trade. Opening just before a major release is closer to a coin toss than a plan.",
    },
]
BY_ID = {lesson["id"]: lesson for lesson in LESSONS}


@router.get("")
def lessons():
    return [{k: v for k, v in lesson.items() if k != "body"} for lesson in LESSONS]


@router.get("/progress")
def progress(user: UserOut = Depends(current_user)):
    with db.conn() as c:
        rows = c.execute("SELECT lesson, return_pct, trades, completed_at FROM lesson_progress WHERE user_id = %s",
                         (user.id,)).fetchall()
    return {r["lesson"]: {"return_pct": r["return_pct"], "trades": r["trades"], "completed_at": r["completed_at"]} for r in rows}


@router.get("/{lesson_id}")
def lesson(lesson_id: str):
    if lesson_id not in BY_ID:
        raise HTTPException(404, "No such lesson")
    i = LESSONS.index(BY_ID[lesson_id])
    return {**BY_ID[lesson_id], "next": LESSONS[i + 1]["id"] if i + 1 < len(LESSONS) else None}


class DoneIn(BaseModel):
    return_pct: float = Field(ge=-100, le=10_000)
    trades: int = Field(ge=0, le=500)


@router.post("/{lesson_id}/complete")
def complete(lesson_id: str, body: DoneIn, user: UserOut = Depends(current_user)):
    if lesson_id not in BY_ID:
        raise HTTPException(404, "No such lesson")
    with db.conn() as c:
        c.execute(
            "INSERT INTO lesson_progress (user_id, lesson, return_pct, trades, completed_at) VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (user_id, lesson) DO UPDATE SET return_pct = EXCLUDED.return_pct, trades = EXCLUDED.trades, "
            "completed_at = EXCLUDED.completed_at",
            (user.id, lesson_id, round(body.return_pct, 2), body.trades, datetime.now(timezone.utc)),
        )
    return progress(user)
