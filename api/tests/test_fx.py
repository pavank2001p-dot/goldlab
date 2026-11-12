import httpx

from app import fx


def test_rates_use_feed_and_pegs(client, monkeypatch):
    fx.clear_cache()
    calls = []

    def fake(*a, **k):
        calls.append(k["params"])
        return httpx.Response(200, json={"date": "2026-11-11", "rates": {"INR": 88.5, "EUR": 0.9, "AED": 9.9}},
                              request=httpx.Request("GET", "https://x"))

    monkeypatch.setattr(fx.httpx, "get", fake)
    body = client.get("/fx").json()
    assert body["source"] == "ecb" and body["as_of"] == "2026-11-11"
    assert body["rates"]["INR"] == 88.5 and body["rates"]["USD"] == 1.0
    # The dirham is pegged, whatever the feed says, and isn't asked for.
    assert body["rates"]["AED"] == 3.6725 and "AED" not in calls[0]["symbols"]
    # Cached: a second call doesn't fetch again.
    client.get("/fx")
    assert len(calls) == 1
    fx.clear_cache()


def test_rates_fall_back_when_feed_fails(client, monkeypatch):
    fx.clear_cache()

    def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(fx.httpx, "get", boom)
    body = client.get("/fx").json()
    assert body["source"] == "fallback" and body["as_of"] is None
    assert body["rates"]["INR"] > 0 and body["rates"]["AED"] == 3.6725
    fx.clear_cache()
