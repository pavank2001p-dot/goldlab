"""Risk-appetite quiz. Places each user as conservative, moderate or aggressive and sets the
limits that later weeks check backtests and logged trades against."""

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from . import db
from .auth import UserOut, current_user

router = APIRouter(prefix="/risk", tags=["risk"])

# Each option scores 0 (most cautious) to 3 (most risk-seeking).
CATEGORIES = {
    "experience": {"label": "Experience", "summary": "What you already know about trading and losing money."},
    "goals": {"label": "Goals", "summary": "What you want from trading, and the swings you will accept for it."},
    "capacity": {"label": "Financial cushion", "summary": "How much loss your finances can absorb."},
    "behaviour": {"label": "Under pressure", "summary": "What you do when trades go against you, or for you."},
    "style": {"label": "Trading style", "summary": "How you hold, size and protect your trades."},
}

QUESTIONS = [
    # Experience
    {"key": "experience", "category": "experience",
     "text": "How long have you been trading gold, forex or other leveraged products?",
     "options": ["I haven't started yet", "Less than a year", "1 to 3 years", "More than 3 years"]},
    {"key": "knowledge", "category": "experience",
     "text": "How well do you understand margin, leverage and margin calls?",
     "options": ["Not at all yet", "I have a rough idea", "I understand them well", "I could explain them to someone else"]},
    {"key": "past_losses", "category": "experience",
     "text": "Have you lost money on a trade or investment before?",
     "options": ["No, never", "Yes, and it put me off", "Yes, and I learned from it", "Often. Losses are part of the game"]},
    # Goals
    {"key": "goal", "category": "goals", "text": "What matters most to you?",
     "options": ["Protecting what I have", "Steady growth with small dips",
                 "Strong growth, accepting bigger swings", "The highest return possible"]},
    {"key": "return_target", "category": "goals", "text": "What yearly return would make you happy?",
     "options": ["3% to 5%, steadily", "5% to 10%", "10% to 25%", "More than 25%"]},
    {"key": "tradeoff", "category": "goals",
     "text": "Which of these accounts would you pick? Each shows its best and worst year.",
     "options": ["Best +5%, worst -2%", "Best +12%, worst -8%", "Best +25%, worst -18%", "Best +50%, worst -40%"],
     "visual": "range"},
    # Financial cushion
    {"key": "loss_limit", "category": "capacity",
     "text": "What is the most you could lose in a year without it affecting your life?",
     "options": ["Under 5% of the account", "5% to 15%", "15% to 30%", "More than 30%"]},
    {"key": "money", "category": "capacity", "text": "How would you describe the money you trade with?",
     "options": ["Savings I may need soon", "Savings I won't need for a few years",
                 "Spare money set aside for this", "Money I can afford to lose entirely"]},
    {"key": "income", "category": "capacity", "text": "How steady is your income?",
     "options": ["Uncertain or irregular", "Mostly steady", "Steady", "Steady, with plenty left over each month"]},
    {"key": "emergency", "category": "capacity",
     "text": "How many months of living costs do you have saved outside your trading account?",
     "options": ["Less than 1 month", "1 to 3 months", "3 to 6 months", "More than 6 months"]},
    # Under pressure
    {"key": "drawdown", "category": "behaviour", "text": "Your account falls 20% in a month. What do you do?",
     "options": ["Stop trading and take the money out", "Cut my trade sizes right away",
                 "Wait it out and stick to my plan", "Add more, since prices are lower"]},
    {"key": "losing_streak", "category": "behaviour", "text": "You've just had five losing trades in a row. What next?",
     "options": ["Take a break and review what went wrong", "Keep going with half the size",
                 "Keep going with the same plan", "Trade bigger to win it back"]},
    {"key": "winner", "category": "behaviour", "text": "A trade is up 10% in a day. What do you do?",
     "options": ["Take all the profit now", "Take some profit and move my stop to break-even",
                 "Let it run with a trailing stop", "Add to the position"]},
    {"key": "news", "category": "behaviour",
     "text": "A big announcement (like US inflation figures) is due in a few minutes and you have a trade open.",
     "options": ["Close it before the news", "Make it smaller", "Leave it as it is", "Add to it to catch the move"]},
    # Trading style
    {"key": "horizon", "category": "style", "text": "How long do you usually hold a trade?",
     "options": ["Months or longer", "Weeks", "Days", "Minutes to hours"]},
    {"key": "leverage", "category": "style", "text": "How do you feel about leverage (trading more than your balance)?",
     "options": ["I avoid it", "A little, carefully", "Moderate leverage is fine", "High leverage is fine"]},
    {"key": "stops", "category": "style", "text": "How do you use stop losses?",
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


def breakdown(answers: dict[str, int]) -> list[dict]:
    """Score per category as a percentage of its maximum, for the categories answered."""
    out = []
    for key, cat in CATEGORIES.items():
        qs = [q["key"] for q in QUESTIONS if q["category"] == key and q["key"] in answers]
        if qs:
            out.append({"key": key, **cat, "pct": round(sum(answers[k] for k in qs) / (3 * len(qs)) * 100)})
    return out


def _out(row: dict) -> dict:
    # Profiles saved before questions were added keep the score they were given, out of
    # the questions they answered.
    answered = [k for k in row["answers"] if k in {q["key"] for q in QUESTIONS}] or list(row["answers"])
    return {"profile": row["profile"], "score": row["score"], "max_score": 3 * len(answered),
            "answers": row["answers"], "updated_at": row["updated_at"], "breakdown": breakdown(row["answers"]),
            "complete": len(answered) == len(QUESTIONS), **PROFILES[row["profile"]]}


@router.get("/quiz")
def quiz():
    return {"questions": QUESTIONS, "categories": CATEGORIES, "profiles": PROFILES}


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
