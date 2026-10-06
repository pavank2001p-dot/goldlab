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
