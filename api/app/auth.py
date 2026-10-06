from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
import psycopg
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, EmailStr, Field

from . import config, db

COOKIE = "gl_session"
router = APIRouter(prefix="/auth", tags=["auth"])


class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(default="", max_length=80)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=128)


class UserOut(BaseModel):
    id: int
    email: str
    name: str


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _check(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _issue(resp: Response, user_id: int) -> None:
    exp = datetime.now(timezone.utc) + timedelta(days=config.SESSION_DAYS)
    token = jwt.encode({"sub": str(user_id), "exp": exp}, config.JWT_SECRET, algorithm="HS256")
    resp.set_cookie(
        COOKIE,
        token,
        max_age=config.SESSION_DAYS * 86400,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def current_user(gl_session: str | None = Cookie(default=None)) -> UserOut:
    if not gl_session:
        raise HTTPException(401, "Not signed in")
    try:
        payload = jwt.decode(gl_session, config.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Session expired, please sign in again")
    with db.conn() as c:
        row = c.execute("SELECT id, email, name FROM users WHERE id = %s", (int(payload["sub"]),)).fetchone()
    if not row:
        raise HTTPException(401, "Not signed in")
    return UserOut(**row)


@router.post("/signup", response_model=UserOut, status_code=201)
def signup(body: SignupIn, resp: Response):
    email = body.email.lower()
    try:
        with db.conn() as c:
            row = c.execute(
                "INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING id, email, name",
                (email, body.name.strip(), _hash(body.password)),
            ).fetchone()
    except psycopg.errors.UniqueViolation:
        raise HTTPException(409, "An account with this email already exists")
    _issue(resp, row["id"])
    return UserOut(**row)


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, resp: Response):
    with db.conn() as c:
        row = c.execute(
            "SELECT id, email, name, password_hash FROM users WHERE email = %s", (body.email.lower(),)
        ).fetchone()
    if not row or not _check(body.password, row["password_hash"]):
        raise HTTPException(401, "Wrong email or password")
    _issue(resp, row["id"])
    return UserOut(id=row["id"], email=row["email"], name=row["name"])


@router.post("/logout", status_code=204)
def logout(resp: Response):
    resp.delete_cookie(COOKIE, path="/")


@router.get("/me", response_model=UserOut)
def me(user: UserOut = Depends(current_user)):
    return user
