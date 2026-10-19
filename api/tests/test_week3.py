import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app import calendar, config, news, risk

UTC = timezone.utc


def test_relevance():
    assert news.relevance("Gold hits record as dollar slides") == 2
    assert news.relevance("Fed's Powell signals rate cuts later this year") == 1
    assert news.relevance("Apple unveils new iPhone") == 0
    assert news.relevance("Goldman Sachs earnings beat") == 0  # word boundary, not "gold"


class FakeClient:
    def __init__(self, payload, stop="end_turn"):
        self.calls = []
        outer = self

        class Messages:
            def create(self, **kw):
                outer.calls.append(kw)
                return SimpleNamespace(stop_reason=stop, stop_details=None,
                                       content=[SimpleNamespace(type="text", text=json.dumps(payload))])

        self.beta = SimpleNamespace(messages=Messages())


def test_classify_sends_schema_and_filters_unknown_ids():
    fake = FakeClient({"items": [
        {"id": 1, "impact": "bullish", "reason": "Rate cuts lower the cost of holding gold."},
        {"id": 99, "impact": "bearish", "reason": "Not one of ours."},
    ]})
    out = news.classify(fake, [{"id": 1, "headline": "Fed signals cuts", "summary": ""}])
    assert out == [{"id": 1, "impact": "bullish", "reason": "Rate cuts lower the cost of holding gold."}]
    kw = fake.calls[0]
    assert kw["output_config"]["format"]["type"] == "json_schema"
    assert kw["fallbacks"] == "default" and kw["betas"] == ["server-side-fallback-2026-07-01"]


def test_classify_handles_refusal():
    assert news.classify(FakeClient({}, stop="refusal"), [{"id": 1, "headline": "x", "summary": ""}]) == []


def test_news_store_tag_and_list(client, monkeypatch):
    now = datetime.now(UTC)
    items = [
        {"source": "finnhub", "external_id": str(i), "headline": h, "summary": "", "url": "https://example.com",
         "publisher": "Reuters", "published_at": now - timedelta(minutes=i), "relevance": news.relevance(h)}
        for i, h in enumerate(["Gold climbs to record", "US CPI hotter than expected"])
    ]
    assert news.store(items) == 2
    assert news.store(items) == 0  # duplicates ignored

    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test")
    fake = FakeClient({"items": [{"id": 1, "impact": "bullish", "reason": "Momentum."},
                                 {"id": 2, "impact": "bearish", "reason": "Rates may stay high."}]})
    monkeypatch.setattr(news.anthropic, "Anthropic", lambda api_key: fake)
    assert news.tag_pending() == 2

    body = client.get("/news").json()
    assert [i["impact"] for i in body["items"]] == ["bullish", "bearish"]
    assert len(client.get("/news", params={"gold_only": True}).json()["items"]) == 1


def test_calendar_seed_feed_and_list(client, monkeypatch):
    soon = (datetime.now(UTC) + timedelta(days=2)).replace(microsecond=0)
    feed = [
        {"title": "CPI m/m", "country": "USD", "date": soon.isoformat(), "impact": "High", "forecast": "0.3%", "previous": "0.2%"},
        {"title": "German ZEW", "country": "EUR", "date": soon.isoformat(), "impact": "High"},
        {"title": "Crude Oil Inventories", "country": "USD", "date": soon.isoformat(), "impact": "Low"},
    ]

    class Resp:
        def raise_for_status(self): ...
        def json(self): return feed

    monkeypatch.setattr(calendar.httpx, "get", lambda *a, **k: Resp())
    assert calendar.update() == 1
    events = client.get("/calendar", params={"days": 30}).json()
    cpi = next(e for e in events if e["title"] == "CPI m/m")
    assert cpi["forecast"] == "0.3%" and "inflation" in cpi["why"].lower()
    with __import__("app.db", fromlist=["conn"]).conn() as c:
        assert c.execute("SELECT count(*) AS n FROM events WHERE title = 'FOMC rate decision'").fetchone()["n"] == 8


def test_risk_quiz(client):
    q = client.get("/risk/quiz").json()["questions"]
    assert client.post("/risk/profile", json={"answers": {}}).status_code == 401
    client.post("/auth/signup", json={"email": "r@example.com", "password": "longenough"})
    assert client.get("/risk/profile").status_code == 404
    assert client.post("/risk/profile", json={"answers": {q[0]["key"]: 1}}).status_code == 422

    cautious = client.post("/risk/profile", json={"answers": {x["key"]: 0 for x in q}}).json()
    assert cautious["profile"] == "conservative" and cautious["max_risk_per_trade_pct"] == 0.5
    middle = client.post("/risk/profile", json={"answers": {x["key"]: (1 if i % 2 else 2) for i, x in enumerate(q)}}).json()
    assert middle["profile"] == "moderate"
    bold = client.post("/risk/profile", json={"answers": {x["key"]: 3 for x in q}}).json()
    assert bold["profile"] == "aggressive"
    assert client.get("/risk/profile").json()["profile"] == "aggressive"


def test_risk_thresholds():
    assert risk.place(0) == "conservative"
    assert risk.place(risk.MAX_SCORE) == "aggressive"
