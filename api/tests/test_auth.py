def test_signup_login_me_logout(client):
    r = client.post("/auth/signup", json={"email": "Ana@Example.com", "password": "goldbug123", "name": "Ana"})
    assert r.status_code == 201
    assert r.json()["email"] == "ana@example.com"
    assert client.get("/auth/me").json()["name"] == "Ana"

    assert client.post("/auth/logout").status_code == 204
    client.cookies.clear()
    assert client.get("/auth/me").status_code == 401

    assert client.post("/auth/login", json={"email": "ana@example.com", "password": "wrong-pass"}).status_code == 401
    r = client.post("/auth/login", json={"email": "ANA@example.com", "password": "goldbug123"})
    assert r.status_code == 200
    assert client.get("/auth/me").status_code == 200


def test_duplicate_and_weak_password(client):
    body = {"email": "b@example.com", "password": "longenough"}
    assert client.post("/auth/signup", json=body).status_code == 201
    assert client.post("/auth/signup", json=body).status_code == 409
    assert client.post("/auth/signup", json={"email": "c@example.com", "password": "short"}).status_code == 422


def test_tampered_cookie_rejected(client):
    client.cookies.set("gl_session", "not-a-jwt")
    assert client.get("/auth/me").status_code == 401


# ---- email verification, password reset and Google sign-in ----

import re

from app import auth, config, db, mailer


def _link_token(mail):
    return re.search(r"token=([\w-]+)", mail.text).group(1)


def _age_tokens():
    # Skip the one-a-minute email limit.
    with db.conn() as c:
        c.execute("UPDATE auth_tokens SET created_at = created_at - interval '2 minutes'")


def test_signup_sends_verification_and_link_verifies(client):
    mailer.outbox.clear()
    r = client.post("/auth/signup", json={"email": "v@example.com", "password": "goldbug123", "name": "Vi"})
    assert r.json()["email_verified"] is False
    assert len(mailer.outbox) == 1 and mailer.outbox[0].to == "v@example.com"
    token = _link_token(mailer.outbox[0])
    assert "/verify-email?token=" in mailer.outbox[0].text

    # Resending inside a minute is refused.
    assert client.post("/auth/verify/resend").status_code == 429
    assert client.post("/auth/verify", json={"token": "x" * 20}).status_code == 400
    assert client.post("/auth/verify", json={"token": token}).status_code == 200
    assert client.get("/auth/me").json()["email_verified"] is True
    # Links work once.
    assert client.post("/auth/verify", json={"token": token}).status_code == 400
    assert client.post("/auth/verify/resend").json()["already_verified"] is True


def test_resend_after_cooldown(client):
    client.post("/auth/signup", json={"email": "r@example.com", "password": "goldbug123"})
    _age_tokens()
    mailer.outbox.clear()
    assert client.post("/auth/verify/resend").status_code == 202
    assert len(mailer.outbox) == 1


def test_password_reset_flow(client):
    client.post("/auth/signup", json={"email": "p@example.com", "password": "oldpassword"})
    old_cookie = client.cookies.get("gl_session")
    mailer.outbox.clear()

    # Unknown emails get the same answer and no email.
    assert client.post("/auth/password/forgot", json={"email": "nobody@example.com"}).status_code == 202
    assert mailer.outbox == []

    assert client.post("/auth/password/forgot", json={"email": "P@example.com"}).status_code == 202
    assert len(mailer.outbox) == 1
    token = _link_token(mailer.outbox[0])
    # A second request inside a minute sends nothing more.
    client.post("/auth/password/forgot", json={"email": "p@example.com"})
    assert len(mailer.outbox) == 1

    assert client.post("/auth/password/reset", json={"token": token, "password": "short"}).status_code == 422
    r = client.post("/auth/password/reset", json={"token": token, "password": "newpassword"})
    assert r.status_code == 200
    assert r.json()["email_verified"] is True
    assert client.get("/auth/me").status_code == 200
    assert client.post("/auth/password/reset", json={"token": token, "password": "another-one"}).status_code == 400

    # The session from before the reset no longer works.
    client.cookies.clear()
    client.cookies.set("gl_session", old_cookie)
    assert client.get("/auth/me").status_code == 401
    client.cookies.clear()
    assert client.post("/auth/login", json={"email": "p@example.com", "password": "oldpassword"}).status_code == 401
    assert client.post("/auth/login", json={"email": "p@example.com", "password": "newpassword"}).status_code == 200


def test_expired_reset_link(client):
    client.post("/auth/signup", json={"email": "e@example.com", "password": "oldpassword"})
    mailer.outbox.clear()
    client.post("/auth/password/forgot", json={"email": "e@example.com"})
    token = _link_token(mailer.outbox[0])
    with db.conn() as c:
        c.execute("UPDATE auth_tokens SET expires_at = now() - interval '1 second'")
    assert client.post("/auth/password/reset", json={"token": token, "password": "newpassword"}).status_code == 400


def test_google_disabled_without_keys(client, monkeypatch):
    monkeypatch.setattr(config, "GOOGLE_CLIENT_ID", "")
    assert client.get("/auth/config").json() == {"google": False}
    assert client.get("/auth/google/start", follow_redirects=False).status_code == 404


def _google(monkeypatch, claims):
    monkeypatch.setattr(config, "GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setattr(config, "GOOGLE_CLIENT_SECRET", "secret")
    monkeypatch.setattr(auth, "_exchange_code", lambda code, verifier: claims)


def _google_login(client, next_path="/paper"):
    r = client.get(f"/auth/google/start?next={next_path}", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith(auth.GOOGLE_AUTH_URL)
    assert "code_challenge=" in r.headers["location"]
    state = re.search(r"state=([\w-]+)", r.headers["location"]).group(1)
    return client.get(f"/auth/google/callback?code=abc&state={state}", follow_redirects=False)


def test_google_creates_account(client, monkeypatch):
    _google(monkeypatch, {"sub": "g-1", "email": "G@gmail.com", "email_verified": True, "name": "Gia"})
    assert client.get("/auth/config").json() == {"google": True}
    r = _google_login(client)
    assert r.status_code == 302 and r.headers["location"] == "/paper"
    me = client.get("/auth/me").json()
    assert me["email"] == "g@gmail.com" and me["name"] == "Gia"
    assert me["google"] and me["email_verified"] and not me["has_password"]

    # Password login explains what to do instead.
    client.cookies.clear()
    r = client.post("/auth/login", json={"email": "g@gmail.com", "password": "whatever1"})
    assert r.status_code == 401 and "Google" in r.json()["detail"]
    # Signing in again finds the same account; an unsafe next falls back to /account.
    r = _google_login(client, "//evil.example")
    assert r.headers["location"] == "/account"
    assert client.get("/auth/me").json()["id"] == me["id"]


def test_google_links_verified_account_and_keeps_password(client, monkeypatch):
    client.post("/auth/signup", json={"email": "k@example.com", "password": "goldbug123", "name": "Kay"})
    with db.conn() as c:
        c.execute("UPDATE users SET email_verified_at = now()")
    client.cookies.clear()
    _google(monkeypatch, {"sub": "g-2", "email": "k@example.com", "email_verified": True, "name": "Other"})
    _google_login(client)
    me = client.get("/auth/me").json()
    assert me["google"] and me["has_password"] and me["name"] == "Kay"


def test_google_takes_over_unverified_signup_safely(client, monkeypatch):
    # Someone signed up with this address first but never confirmed it.
    client.post("/auth/signup", json={"email": "victim@example.com", "password": "attacker1"})
    squatter = client.cookies.get("gl_session")
    client.cookies.clear()
    _google(monkeypatch, {"sub": "g-3", "email": "victim@example.com", "email_verified": True})
    _google_login(client)
    assert client.get("/auth/me").json()["has_password"] is False
    client.cookies.clear()
    client.cookies.set("gl_session", squatter)
    assert client.get("/auth/me").status_code == 401
    client.cookies.clear()
    assert client.post("/auth/login", json={"email": "victim@example.com", "password": "attacker1"}).status_code == 401


def test_google_rejects_bad_state_and_unverified_email(client, monkeypatch):
    _google(monkeypatch, {"sub": "g-4", "email": "u@example.com", "email_verified": False})
    client.get("/auth/google/start", follow_redirects=False)
    r = client.get("/auth/google/callback?code=abc&state=wrong", follow_redirects=False)
    assert r.headers["location"] == "/login?error=google_expired"
    r = _google_login(client)
    assert r.headers["location"] == "/login?error=google_unverified"
    r = client.get("/auth/google/callback?error=access_denied", follow_redirects=False)
    assert r.headers["location"] == "/login?error=google_cancelled"
