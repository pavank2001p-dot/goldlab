import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import bcrypt
import httpx
import jwt
import psycopg
from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, HTTPException, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, Field

from . import config, db, mailer

COOKIE = "gl_session"
OAUTH_COOKIE = "gl_oauth"
# One email of each kind per user per minute, so the endpoints can't be used to flood an inbox.
EMAIL_COOLDOWN = timedelta(seconds=60)
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")

router = APIRouter(prefix="/auth", tags=["auth"])


class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(default="", max_length=80)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=128)


class ForgotIn(BaseModel):
    email: EmailStr


class ResetIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=8, max_length=128)


class TokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    email_verified: bool = False
    has_password: bool = True
    google: bool = False


_USER_COLS = """id, email, name, session_version,
    email_verified_at IS NOT NULL AS email_verified,
    password_hash IS NOT NULL AS has_password,
    google_sub IS NOT NULL AS google"""


def _out(row: dict) -> UserOut:
    return UserOut(**{k: row[k] for k in UserOut.model_fields})


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _check(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _issue(resp: Response, user_id: int, version: int = 0) -> None:
    exp = datetime.now(timezone.utc) + timedelta(days=config.SESSION_DAYS)
    token = jwt.encode({"sub": str(user_id), "v": version, "exp": exp}, config.JWT_SECRET, algorithm="HS256")
    resp.set_cookie(
        COOKIE,
        token,
        max_age=config.SESSION_DAYS * 86400,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def _session_user(gl_session: str | None) -> dict:
    if not gl_session:
        raise HTTPException(401, "Not signed in")
    try:
        payload = jwt.decode(gl_session, config.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Session expired, please sign in again")
    with db.conn() as c:
        row = c.execute(f"SELECT {_USER_COLS} FROM users WHERE id = %s", (int(payload["sub"]),)).fetchone()
    # A password reset bumps session_version, which signs out every older session.
    if not row or row["session_version"] != payload.get("v", 0):
        raise HTTPException(401, "Session expired, please sign in again")
    return row


def current_user(gl_session: str | None = Cookie(default=None)) -> UserOut:
    row = _session_user(gl_session)
    from . import analytics  # imported here: analytics depends on this module

    analytics.touch(row["id"])
    return _out(row)


# ---- one-time email links ----------------------------------------------------------------------


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _new_token(c, user_id: int, email: str, purpose: str, ttl: timedelta) -> str | None:
    """Stores a new link token, or returns None if one of this kind was sent less than a minute ago."""
    recent = c.execute(
        "SELECT 1 FROM auth_tokens WHERE user_id = %s AND purpose = %s AND created_at > now() - %s",
        (user_id, purpose, EMAIL_COOLDOWN),
    ).fetchone()
    if recent:
        return None
    token = secrets.token_urlsafe(32)
    c.execute(
        "INSERT INTO auth_tokens (token_hash, user_id, purpose, email, expires_at) VALUES (%s, %s, %s, %s, now() + %s)",
        (_token_hash(token), user_id, purpose, email, ttl),
    )
    return token


def _use_token(c, token: str, purpose: str) -> dict | None:
    """Marks a valid, unused, unexpired token as used and returns its user, or None."""
    return c.execute(
        """UPDATE auth_tokens t SET used_at = now()
            FROM users u
            WHERE t.token_hash = %s AND t.purpose = %s AND t.used_at IS NULL AND t.expires_at > now()
              AND u.id = t.user_id AND u.email = t.email
            RETURNING u.id, u.email, u.name""",
        (_token_hash(token), purpose),
    ).fetchone()


def _send_verification(bg: BackgroundTasks, c, user_id: int, email: str, name: str) -> bool:
    token = _new_token(c, user_id, email, "verify", timedelta(hours=config.VERIFY_TOKEN_HOURS))
    if token is None:
        return False
    url = f"{config.APP_URL}/verify-email?token={token}"
    bg.add_task(mailer.send, mailer.verification(email, name, url))
    return True


# ---- email and password ------------------------------------------------------------------------


@router.get("/config")
def auth_config():
    """What the sign-in page should offer."""
    return {"google": bool(config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET)}


@router.post("/signup", response_model=UserOut, status_code=201)
def signup(body: SignupIn, resp: Response, bg: BackgroundTasks):
    email = body.email.lower()
    try:
        with db.conn() as c:
            row = c.execute(
                f"INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING {_USER_COLS}",
                (email, body.name.strip(), _hash(body.password)),
            ).fetchone()
            _send_verification(bg, c, row["id"], email, row["name"])
    except psycopg.errors.UniqueViolation:
        raise HTTPException(409, "An account with this email already exists")
    _issue(resp, row["id"], row["session_version"])
    return _out(row)


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, resp: Response):
    with db.conn() as c:
        row = c.execute(
            f"SELECT {_USER_COLS}, password_hash FROM users WHERE email = %s", (body.email.lower(),)
        ).fetchone()
    if row and row["password_hash"] is None:
        raise HTTPException(
            401, "This account signs in with Google. Use Continue with Google, or reset your password to add one."
        )
    if not row or not _check(body.password, row["password_hash"]):
        raise HTTPException(401, "Wrong email or password")
    _issue(resp, row["id"], row["session_version"])
    return _out(row)


@router.post("/logout", status_code=204)
def logout(resp: Response):
    resp.delete_cookie(COOKIE, path="/")


@router.get("/me", response_model=UserOut)
def me(user: UserOut = Depends(current_user)):
    return user


@router.post("/verify/resend", status_code=202)
def resend_verification(bg: BackgroundTasks, user: UserOut = Depends(current_user)):
    if user.email_verified:
        return {"sent": False, "already_verified": True}
    with db.conn() as c:
        if not _send_verification(bg, c, user.id, user.email, user.name):
            raise HTTPException(429, "We just sent one. Please wait a minute before asking again.")
    return {"sent": True}


@router.post("/verify")
def verify_email(body: TokenIn):
    with db.conn() as c:
        row = _use_token(c, body.token, "verify")
        if not row:
            raise HTTPException(400, "This link has expired or was already used. Send yourself a new one from your account page.")
        c.execute("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = %s", (row["id"],))
    return {"verified": True, "email": row["email"]}


@router.post("/password/forgot", status_code=202)
def forgot_password(body: ForgotIn, bg: BackgroundTasks):
    # Same answer whether or not the account exists, so this can't be used to find out who has one.
    email = body.email.lower()
    with db.conn() as c:
        row = c.execute("SELECT id, email, name FROM users WHERE email = %s", (email,)).fetchone()
        if row:
            token = _new_token(c, row["id"], email, "reset", timedelta(minutes=config.RESET_TOKEN_MINUTES))
            if token:
                url = f"{config.APP_URL}/reset-password?token={token}"
                bg.add_task(mailer.send, mailer.password_reset(email, row["name"], url))
    return {"sent": True}


@router.post("/password/reset", response_model=UserOut)
def reset_password(body: ResetIn, resp: Response):
    with db.conn() as c:
        row = _use_token(c, body.token, "reset")
        if not row:
            raise HTTPException(400, "This reset link has expired or was already used. Ask for a new one.")
        # Opening the link proves the inbox is theirs, so the email counts as confirmed too.
        row = c.execute(
            f"""UPDATE users SET password_hash = %s, session_version = session_version + 1,
                   email_verified_at = COALESCE(email_verified_at, now())
                WHERE id = %s RETURNING {_USER_COLS}""",
            (_hash(body.password), row["id"]),
        ).fetchone()
        c.execute(
            "UPDATE auth_tokens SET used_at = now() WHERE user_id = %s AND purpose = 'reset' AND used_at IS NULL",
            (row["id"],),
        )
    _issue(resp, row["id"], row["session_version"])
    return _out(row)


# ---- Google sign-in (OpenID Connect, authorization code flow with PKCE) -------------------------


def _google_ready() -> None:
    if not (config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET):
        raise HTTPException(404, "Google sign-in isn't set up")


def _redirect_uri() -> str:
    return f"{config.APP_URL}/api/auth/google/callback"


def _safe_next(next_path: str | None) -> str:
    # Only same-site paths, never //host or a full URL.
    if next_path and next_path.startswith("/") and not next_path.startswith("//") and "\\" not in next_path:
        return next_path
    return "/account"


def _login_error(code: str) -> RedirectResponse:
    r = RedirectResponse(f"/login?error={code}", status_code=302)
    r.delete_cookie(OAUTH_COOKIE, path="/")
    return r


@router.get("/google/start")
def google_start(next: str | None = None):
    _google_ready()
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = {
        "client_id": config.GOOGLE_CLIENT_ID,
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    r = RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}", status_code=302)
    exp = datetime.now(timezone.utc) + timedelta(minutes=10)
    cookie = jwt.encode(
        {"state": state, "verifier": verifier, "next": _safe_next(next), "exp": exp}, config.JWT_SECRET, algorithm="HS256"
    )
    # Lax is enough: Google returns with a top-level GET, which carries Lax cookies.
    r.set_cookie(OAUTH_COOKIE, cookie, max_age=600, httponly=True, secure=config.COOKIE_SECURE, samesite="lax", path="/")
    return r


def _exchange_code(code: str, verifier: str) -> dict:
    """Swaps the code for Google's ID token and returns its claims."""
    r = httpx.post(
        GOOGLE_TOKEN_URL,
        data={
            "code": code,
            "client_id": config.GOOGLE_CLIENT_ID,
            "client_secret": config.GOOGLE_CLIENT_SECRET,
            "redirect_uri": _redirect_uri(),
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        },
        timeout=15,
    )
    r.raise_for_status()
    id_token = r.json()["id_token"]
    # The token came straight from Google's token endpoint over TLS, which OpenID Connect accepts
    # in place of checking its signature (Core 1.0, 3.1.3.7). The claims are still checked.
    claims = jwt.decode(id_token, options={"verify_signature": False})
    now = datetime.now(timezone.utc).timestamp()
    if claims.get("iss") not in GOOGLE_ISSUERS or claims.get("aud") != config.GOOGLE_CLIENT_ID or claims.get("exp", 0) < now:
        raise ValueError("ID token failed checks")
    return claims


def google_user(claims: dict) -> dict | None:
    """Finds or creates the account for a Google identity. None if it can't be used safely."""
    sub = str(claims.get("sub") or "")
    email = str(claims.get("email") or "").lower()
    if not sub or not email or claims.get("email_verified") is not True:
        return None
    name = str(claims.get("name") or "")[:80]
    with db.conn() as c:
        row = c.execute(f"SELECT {_USER_COLS} FROM users WHERE google_sub = %s", (sub,)).fetchone()
        if row:
            return row
        # Google has confirmed the address, so an existing account with it is linked and counts as verified.
        # If that account's email was never confirmed, someone else may have signed up with it first, so
        # its password is removed and its sessions ended; the owner can set a password with a reset link.
        row = c.execute(
            f"""UPDATE users SET google_sub = %s, email_verified_at = COALESCE(email_verified_at, now()),
                   password_hash = CASE WHEN email_verified_at IS NULL THEN NULL ELSE password_hash END,
                   session_version = session_version + CASE WHEN email_verified_at IS NULL THEN 1 ELSE 0 END,
                   name = CASE WHEN name = '' THEN %s ELSE name END
                WHERE email = %s AND google_sub IS NULL RETURNING {_USER_COLS}""",
            (sub, name, email),
        ).fetchone()
        if row:
            return row
        try:
            return c.execute(
                f"""INSERT INTO users (email, name, google_sub, email_verified_at)
                    VALUES (%s, %s, %s, now()) RETURNING {_USER_COLS}""",
                (email, name, sub),
            ).fetchone()
        except psycopg.errors.UniqueViolation:
            # The email belongs to an account already linked to a different Google identity.
            return None


@router.get("/google/callback")
def google_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    gl_oauth: str | None = Cookie(default=None),
):
    _google_ready()
    if error:
        return _login_error("google_cancelled")
    try:
        saved = jwt.decode(gl_oauth or "", config.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return _login_error("google_expired")
    if not code or not state or not secrets.compare_digest(state, saved.get("state", "")):
        return _login_error("google_expired")
    try:
        claims = _exchange_code(code, saved["verifier"])
    except Exception:
        return _login_error("google_failed")
    row = google_user(claims)
    if not row:
        return _login_error("google_unverified")
    r = RedirectResponse(_safe_next(saved.get("next")), status_code=302)
    r.delete_cookie(OAUTH_COOKIE, path="/")
    _issue(r, row["id"], row["session_version"])
    return r
