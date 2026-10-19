"""Gold news: pull headlines from Finnhub, keep the ones that can move gold, and have
Claude tag each as bullish, bearish or neutral for gold with a one-line reason."""

import json
import logging
import re
from datetime import datetime, timezone

import anthropic
import httpx
from fastapi import APIRouter, Query

from . import config, db

log = logging.getLogger("news")
router = APIRouter(prefix="/news", tags=["news"])

FINNHUB = "https://finnhub.io/api/v1/news"
GOLD = re.compile(r"\b(gold|xau|bullion|precious metals?)\b", re.I)
MACRO = re.compile(
    r"\b(fed|fomc|federal reserve|powell|interest rates?|rate (cut|hike)s?|inflation|cpi|pce|payrolls?|"
    r"jobs report|treasur(y|ies)|bond yields?|yields?|dollar|dxy|recession|central banks?|safe[- ]haven|"
    r"geopolitic\w*|war|sanctions?|tariffs?)\b",
    re.I,
)
TAG_BATCH = 20


def relevance(text: str) -> int:
    """2 = about gold itself, 1 = a macro driver of gold, 0 = ignore."""
    if GOLD.search(text):
        return 2
    return 1 if MACRO.search(text) else 0


def fetch_finnhub() -> list[dict]:
    out = []
    with httpx.Client(timeout=20) as client:
        for category in ("general", "forex"):
            r = client.get(FINNHUB, params={"category": category, "token": config.FINNHUB_API_KEY})
            r.raise_for_status()
            for item in r.json():
                text = f"{item.get('headline', '')} {item.get('summary', '')}"
                rel = relevance(text)
                if not rel or not item.get("headline"):
                    continue
                out.append({
                    "source": "finnhub",
                    "external_id": str(item.get("id") or item.get("url")),
                    "headline": item["headline"].strip()[:500],
                    "summary": (item.get("summary") or "").strip()[:2000],
                    "url": item.get("url") or "",
                    "publisher": item.get("source") or "",
                    "published_at": datetime.fromtimestamp(int(item["datetime"]), timezone.utc),
                    "relevance": rel,
                })
    return out


def store(items: list[dict]) -> int:
    if not items:
        return 0
    with db.conn() as c, c.cursor() as cur:
        cur.executemany(
            """INSERT INTO news (source, external_id, headline, summary, url, publisher, published_at, relevance)
               VALUES (%(source)s, %(external_id)s, %(headline)s, %(summary)s, %(url)s, %(publisher)s,
                       %(published_at)s, %(relevance)s)
               ON CONFLICT (source, external_id) DO NOTHING""",
            items,
        )
        return cur.rowcount


# ---------------------------------------------------------------------------
# Tagging with Claude
# ---------------------------------------------------------------------------

SYSTEM = (
    "You assess how news headlines are likely to affect the price of gold (XAU/USD) in the short term. "
    "Gold tends to rise on lower expected US interest rates, a weaker US dollar, higher inflation fears and "
    "geopolitical or financial stress, and to fall on the opposite. For each item, decide whether it is "
    "bullish, bearish or neutral for gold and give one plain-English sentence (under 25 words) saying why, "
    "written for a beginner. Use neutral when the effect is unclear or minor. This is educational context, "
    "not a trading recommendation: never tell the reader to buy or sell."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "impact": {"type": "string", "enum": ["bullish", "bearish", "neutral"]},
                    "reason": {"type": "string"},
                },
                "required": ["id", "impact", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def classify(client: anthropic.Anthropic, rows: list[dict]) -> list[dict]:
    """One request per batch of headlines; returns [{id, impact, reason}]."""
    listing = "\n\n".join(
        f"id: {r['id']}\nheadline: {r['headline']}\nsummary: {r['summary'][:600]}" for r in rows
    )
    resp = client.beta.messages.create(
        model=config.NEWS_MODEL,
        max_tokens=4000,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"Tag each of these news items:\n\n{listing}"}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if resp.stop_reason == "refusal":
        log.warning("news tagging declined: %s", getattr(resp.stop_details, "category", None))
        return []
    if resp.stop_reason == "max_tokens":
        log.warning("news tagging hit max_tokens; will retry next run")
        return []
    text = next(b.text for b in resp.content if b.type == "text")
    valid = {r["id"] for r in rows}
    return [i for i in json.loads(text)["items"] if i["id"] in valid]


def tag_pending(limit: int = 100) -> int:
    if not config.ANTHROPIC_API_KEY:
        return 0
    with db.conn() as c:
        rows = c.execute(
            "SELECT id, headline, summary FROM news WHERE impact IS NULL ORDER BY published_at DESC LIMIT %s",
            (limit,),
        ).fetchall()
    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    done = 0
    for i in range(0, len(rows), TAG_BATCH):
        try:
            tags = classify(client, rows[i : i + TAG_BATCH])
        except anthropic.APIError as e:
            log.warning("news tagging failed: %s", e)
            break
        with db.conn() as c:
            for t in tags:
                c.execute(
                    "UPDATE news SET impact = %s, reason = %s, tagged_at = now() WHERE id = %s",
                    (t["impact"], t["reason"].strip()[:300], t["id"]),
                )
        done += len(tags)
    return done


def update() -> tuple[int, int]:
    added = store(fetch_finnhub()) if config.FINNHUB_API_KEY else 0
    return added, tag_pending()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@router.get("")
def list_(limit: int = Query(50, ge=1, le=200), gold_only: bool = False):
    sql = "SELECT id, headline, summary, url, publisher, published_at, relevance, impact, reason FROM news"
    if gold_only:
        sql += " WHERE relevance = 2"
    with db.conn() as c:
        rows = c.execute(sql + " ORDER BY published_at DESC LIMIT %s", (limit,)).fetchall()
    return {
        "configured": bool(config.FINNHUB_API_KEY),
        "tagging": bool(config.ANTHROPIC_API_KEY),
        "items": rows,
    }
