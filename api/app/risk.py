"""Risk-appetite quiz. Places each user as conservative, moderate or aggressive and sets the
limits that later weeks check backtests and logged trades against."""

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from . import db
from .auth import UserOut, current_user

router = APIRouter(prefix="/risk", tags=["risk"])

# Each option scores 0 (most cautious) to 3 (most risk-seeking).
QUESTIONS = [
    {"key": "experience", "text": "How long have you been trading gold, forex or other leveraged products?",
     "options": ["I haven't started yet", "Less than a year", "1 to 3 years", "More than 3 years"]},
    {"key": "goal", "text": "What matters most to you?",
     "options": ["Protecting what I have", "Steady growth with small dips",
                 "Strong growth, accepting bigger swings", "The highest return possible"]},
    {"key": "drawdown", "text": "Your account falls 20% in a month. What do you do?",
     "options": ["Stop trading and take the money out", "Cut my trade sizes right away",
                 "Wait it out and stick to my plan", "Add more, since prices are lower"]},
    {"key": "loss_limit", "text": "What is the most you could lose in a year without it affecting your life?",
     "options": ["Under 5% of the account", "5% to 15%", "15% to 30%", "More than 30%"]},
    {"key": "money", "text": "How would you describe the money you trade with?",
     "options": ["Savings I may need soon", "Savings I won't need for a few years",
                 "Spare money set aside for this", "Money I can afford to lose entirely"]},
    {"key": "horizon", "text": "How long do you usually hold a trade?",
     "options": ["Months or longer", "Weeks", "Days", "Minutes to hours"]},
    {"key": "leverage", "text": "How do you feel about leverage (trading more than your balance)?",
     "options": ["I avoid it", "A little, carefully", "Moderate leverage is fine", "High leverage is fine"]},
    {"key": "stops", "text": "How do you use stop losses?",
     "options": ["On every trade, set tight", "On every trade, with room to move",
                 "Sometimes", "Rarely or never"]},
]

MAX_SCORE = 3 * len(QUESTIONS)

PROFILES = {
    "conservative": {
        "label": "Conservative",
        "summary": "You put protecting your money first. Smaller positions, tight risk limits and patience suit you.",
        "max_risk_per_trade_pct": 0.5,
        "max_drawdown_pct": 10,
        "max_leverage": 2,
    },
    "moderate": {
        "label": "Moderate",
        "summary": "You want growth but not at any cost. Balanced position sizes and clear stop losses suit you.",
        "max_risk_per_trade_pct": 1.0,
        "max_drawdown_pct": 20,
        "max_leverage": 5,
    },
    "aggressive": {
        "label": "Aggressive",
        "summary": "You accept large swings for higher potential returns. Even so, losses compound quickly with leverage.",
        "max_risk_per_trade_pct": 2.0,
        "max_drawdown_pct": 35,
        "max_leverage": 10,
    },
}


def place(score: int) -> str:
    pct = score / MAX_SCORE
    return "conservative" if pct < 0.4 else "moderate" if pct < 0.7 else "aggressive"


class AnswersIn(BaseModel):
    answers: dict[str, int]


def _out(row: dict) -> dict:
    return {"profile": row["profile"], "score": row["score"], "max_score": MAX_SCORE,
            "answers": row["answers"], "updated_at": row["updated_at"], **PROFILES[row["profile"]]}


@router.get("/quiz")
def quiz():
    return {"questions": QUESTIONS, "profiles": PROFILES}


@router.post("/profile")
def save(body: AnswersIn, user: UserOut = Depends(current_user)):
    keys = {q["key"] for q in QUESTIONS}
    if set(body.answers) != keys:
        raise HTTPException(422, "Please answer every question")
    if any(not 0 <= v <= 3 for v in body.answers.values()):
        raise HTTPException(422, "Invalid answer")
    score = sum(body.answers.values())
    profile = place(score)
    with db.conn() as c:
        row = c.execute(
            """INSERT INTO risk_profiles (user_id, answers, score, profile) VALUES (%s, %s, %s, %s)
               ON CONFLICT (user_id) DO UPDATE SET answers = EXCLUDED.answers, score = EXCLUDED.score,
                 profile = EXCLUDED.profile, updated_at = now()
               RETURNING answers, score, profile, updated_at""",
            (user.id, Jsonb(body.answers), score, profile),
        ).fetchone()
    return _out(row)


def profile_of(user_id: int) -> dict | None:
    with db.conn() as c:
        row = c.execute(
            "SELECT answers, score, profile, updated_at FROM risk_profiles WHERE user_id = %s", (user_id,)
        ).fetchone()
    return _out(row) if row else None


@router.get("/profile")
def get(user: UserOut = Depends(current_user)):
    p = profile_of(user.id)
    if not p:
        raise HTTPException(404, "No risk profile yet")
    return p
