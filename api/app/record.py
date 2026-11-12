"""Verified track record and Skill Passport.

Every closed paper trade, account reset, deposit or withdrawal and finished prop challenge is sealed into an
append-only ledger per user. Each entry carries the SHA-256 of the one before it, so changing, removing or
re-ordering any entry breaks every hash after it. Starting the paper account over deletes its positions but
not the ledger, so a bad run can't be wiped from the record.

A user can issue a report: a frozen snapshot of the record's stats, Skill Passport level and trades, signed
with a server key (HMAC-SHA256 over the snapshot and the ledger head it was built from). Anyone with the link
can open `/record/verify/{id}`; the server re-walks the chain up to that head and re-checks the signature, so
a report whose ledger or numbers were changed afterwards shows as altered.

Trades placed by the strategy agent are sealed too but left out of the skill stats: they are the strategy's
skill, not the trader's. Everything here is simulated money.
"""

import hashlib
import hmac
import json
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from . import config, db
from .auth import UserOut, current_user
from .report import trading_date

router = APIRouter(prefix="/record", tags=["record"])

GENESIS = "0" * 64
MAX_REPORT_TRADES = 300
_KEY = hmac.new(config.JWT_SECRET.encode(), b"trading-lab-track-record-v1", hashlib.sha256).digest()

# Skill Passport levels. Each is a set of checks on the trader's own trades (agent trades left out). They
# reward process first; only Gold asks for an edge (profit factor) and a passed prop challenge.
LEVELS = [
    {"key": "bronze", "name": "Bronze", "title": "Practitioner",
     "blurb": "Has a real body of practice and uses stops.",
     "checks": [("trades", 20), ("stop_pct", 80), ("max_dd", 25)]},
    {"key": "silver", "name": "Silver", "title": "Disciplined",
     "blurb": "Trades on many days, keeps risk small and doesn't move stops away.",
     "checks": [("trades", 50), ("days", 10), ("stop_pct", 90), ("kept_stop_pct", 90), ("max_dd", 15), ("worst_loss", 3)]},
    {"key": "gold", "name": "Gold", "title": "Consistent",
     "blurb": "Holds a prop firm's standard over 100 trades and has passed a prop challenge.",
     "checks": [("trades", 100), ("days", 20), ("stop_pct", 95), ("kept_stop_pct", 95), ("max_dd", 10), ("worst_loss", 2),
                ("profit_factor", 1.2), ("prop_passed", 1)]},
]
CHECK_TEXT = {
    "trades": ("At least {v:g} closed trades", "{a:g} so far"),
    "days": ("Trades on at least {v:g} different days", "{a:g} days so far"),
    "stop_pct": ("A stop loss on at least {v:g}% of trades", "{a:g}% now"),
    "kept_stop_pct": ("Stop never moved further away on at least {v:g}% of trades", "{a:g}% now"),
    "max_dd": ("Deepest drop from a high no more than {v:g}%", "{a:g}% now"),
    "worst_loss": ("No single loss bigger than {v:g}% of the account", "largest {a:g}%"),
    "profit_factor": ("Profit factor of at least {v:g}", "{a:g} now"),
    "prop_passed": ("Passed a prop challenge", "{a:g} passed"),
}
LOWER_IS_BETTER = {"max_dd", "worst_loss"}


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------

def _norm(x):
    """Whole floats become ints, so 10000.0 and 10000 hash the same however JSONB hands them back."""
    if isinstance(x, float) and x.is_integer():
        return int(x)
    if isinstance(x, dict):
        return {k: _norm(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_norm(v) for v in x]
    return x


def canonical(obj) -> bytes:
    return json.dumps(_norm(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str).encode()


def entry_hash(seq: int, kind: str, data: dict, prev: str) -> str:
    return hashlib.sha256(canonical({"seq": seq, "kind": kind, "data": data, "prev": prev})).hexdigest()


def sign(message: bytes) -> str:
    return hmac.new(_KEY, message, hashlib.sha256).hexdigest()


def _r(x: float | None, n: int = 6) -> float | None:
    return None if x is None else round(float(x), n)


def _iso(t: datetime | None) -> str | None:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds") if t else None


# ---------------------------------------------------------------------------
# Sealing
# ---------------------------------------------------------------------------

def _head(c, user_id: int) -> dict | None:
    return c.execute("SELECT seq, kind, data, hash FROM record_entries WHERE user_id = %s ORDER BY seq DESC LIMIT 1",
                     (user_id,)).fetchone()


def _append(c, user_id: int, kind: str, data: dict, head: dict | None) -> dict:
    seq = head["seq"] + 1 if head else 1
    prev = head["hash"] if head else GENESIS
    data = json.loads(canonical(data))  # exactly what JSONB will hand back
    h = entry_hash(seq, kind, data, prev)
    c.execute("INSERT INTO record_entries (user_id, seq, kind, data, prev_hash, hash) VALUES (%s, %s, %s, %s, %s, %s)",
              (user_id, seq, kind, Jsonb(data), prev, h))
    return {"seq": seq, "kind": kind, "data": data, "hash": h}


def _balance(head: dict | None) -> float | None:
    return None if head is None else head["data"].get("balance")


def seal(c, user_id: int) -> int:
    """Append closed paper trades and finished prop challenges that aren't in the ledger yet. Call with the
    paper account row locked (paper.sync does) so two requests can't seal the same trade."""
    acct = c.execute("SELECT starting_balance, balance FROM paper_accounts WHERE user_id = %s", (user_id,)).fetchone()
    if not acct:
        return 0
    head = _head(c, user_id)
    added = 0
    if head is None:
        # First seal: open the record at the account's starting balance.
        head = _append(c, user_id, "start", {"at": _iso(datetime.now(timezone.utc)),
                                             "balance": _r(acct["starting_balance"], 2)}, None)
        added += 1
    rows = c.execute(
        """SELECT id, symbol, side, units, entry_price, exit_price, opened_at, closed_at, stop_loss, take_profit,
                  close_reason, swap, pnl, agent, stop_widened
           FROM paper_positions WHERE user_id = %s AND closed_at IS NOT NULL AND NOT sealed
           ORDER BY closed_at, id FOR UPDATE""", (user_id,)).fetchall()
    for p in rows:
        before = _balance(head) or 0.0
        after = before + (p["pnl"] or 0.0)
        head = _append(c, user_id, "trade", {
            "position": p["id"], "symbol": p["symbol"], "side": p["side"], "units": _r(p["units"]),
            "entry_price": _r(p["entry_price"]), "exit_price": _r(p["exit_price"]),
            "opened_at": _iso(p["opened_at"]), "closed_at": _iso(p["closed_at"]), "at": _iso(p["closed_at"]),
            "stop_loss": _r(p["stop_loss"]), "take_profit": _r(p["take_profit"]), "reason": p["close_reason"],
            "swap": _r(p["swap"], 2), "pnl": _r(p["pnl"], 2), "agent": bool(p["agent"]),
            "stop_widened": bool(p["stop_widened"]), "balance_before": _r(before, 2), "balance": _r(after, 2),
        }, head)
        added += 1
    if rows:
        c.execute("UPDATE paper_positions SET sealed = true WHERE id = ANY(%s)", ([p["id"] for p in rows],))

    done = c.execute(
        """SELECT id, plan, size, status, fail_rule, ended_at FROM prop_challenges
           WHERE user_id = %s AND status IN ('passed', 'failed') AND NOT sealed ORDER BY ended_at, id FOR UPDATE""",
        (user_id,)).fetchall()
    for ch in done:
        head = _append(c, user_id, "prop", {
            "challenge": ch["id"], "plan": ch["plan"], "size": _r(ch["size"], 2), "result": ch["status"],
            "rule": ch["fail_rule"], "at": _iso(ch["ended_at"]), "balance": _balance(head),
        }, head)
        added += 1
    if done:
        c.execute("UPDATE prop_challenges SET sealed = true WHERE id = ANY(%s)", ([ch["id"] for ch in done],))
    return added


def note_reset(c, user_id: int, balance: float) -> None:
    """Seal what's closed, then record that the account started over. Called before paper.reset deletes."""
    seal(c, user_id)
    _append(c, user_id, "reset", {"at": _iso(datetime.now(timezone.utc)), "balance": _r(balance, 2)}, _head(c, user_id))


def note_funds(c, user_id: int, amount: float) -> None:
    seal(c, user_id)
    head = _head(c, user_id)
    _append(c, user_id, "funds", {"at": _iso(datetime.now(timezone.utc)), "amount": _r(amount, 2),
                                  "balance": _r((_balance(head) or 0.0) + amount, 2)}, head)


# ---------------------------------------------------------------------------
# Verifying and scoring
# ---------------------------------------------------------------------------

def entries(c, user_id: int, upto: int | None = None) -> list[dict]:
    q = "SELECT seq, kind, data, prev_hash, hash, created_at FROM record_entries WHERE user_id = %s"
    args: list = [user_id]
    if upto is not None:
        q += " AND seq <= %s"
        args.append(upto)
    return c.execute(q + " ORDER BY seq", args).fetchall()


def check_chain(rows: list[dict]) -> dict:
    """Re-walk the chain. Returns ok, the head hash, and the first broken entry if any."""
    prev = GENESIS
    for i, e in enumerate(rows, start=1):
        if e["seq"] != i or e["prev_hash"] != prev or entry_hash(e["seq"], e["kind"], e["data"], prev) != e["hash"]:
            return {"ok": False, "head": None, "broken_at": i, "entries": len(rows)}
        prev = e["hash"]
    return {"ok": True, "head": prev, "broken_at": None, "entries": len(rows)}


def stats(rows: list[dict]) -> dict:
    """Skill stats from ledger entries. Returns are per trade on the balance before it and compounded across
    resets, so account size and starting over don't change the picture."""
    own = [e["data"] for e in rows if e["kind"] == "trade" and not e["data"].get("agent")]
    agent = sum(1 for e in rows if e["kind"] == "trade" and e["data"].get("agent"))
    props = [e["data"] for e in rows if e["kind"] == "prop"]
    resets = sum(1 for e in rows if e["kind"] == "reset")
    n = len(own)
    rets = [(t["pnl"] or 0) / t["balance_before"] if t.get("balance_before") else 0.0 for t in own]
    index, peak, max_dd = 1.0, 1.0, 0.0
    for r in rets:
        index *= 1 + r
        peak = max(peak, index)
        max_dd = max(max_dd, (peak - index) / peak if peak > 0 else 0)
    wins = [r for r in rets if r > 0]
    losses = [-r for r in rets if r <= 0]
    gw, gl = sum(wins), sum(losses)
    days = {trading_date(int(datetime.fromisoformat(t["closed_at"]).timestamp())) for t in own}
    with_stop = sum(1 for t in own if t.get("stop_loss") is not None)
    kept = sum(1 for t in own if not t.get("stop_widened"))
    markets: dict[str, int] = {}
    for t in own:
        markets[t["symbol"]] = markets.get(t["symbol"], 0) + 1
    pct = lambda a: round(a / n * 100, 1) if n else 0.0  # noqa: E731
    return {
        "trades": n,
        "agent_trades": agent,
        "days": len(days),
        "first": own[0]["closed_at"] if own else None,
        "last": own[-1]["closed_at"] if own else None,
        "return_pct": round((index - 1) * 100, 2),
        "max_dd": round(max_dd * 100, 2),
        "win_rate_pct": pct(len(wins)),
        "profit_factor": round(gw / gl, 2) if gl > 0 else (None if not wins else 99.0),
        "avg_win_pct": round(gw / len(wins) * 100, 2) if wins else None,
        "avg_loss_pct": round(gl / len(losses) * 100, 2) if losses else None,
        "worst_loss": round(max(losses) * 100, 2) if losses else 0.0,
        "stop_pct": pct(with_stop),
        "kept_stop_pct": pct(kept),
        "markets": sorted(markets.items(), key=lambda kv: -kv[1]),
        "prop_passed": sum(1 for p in props if p["result"] == "passed"),
        "prop_failed": sum(1 for p in props if p["result"] == "failed"),
        "resets": resets,
    }


def _check(key: str, need: float, s: dict) -> dict:
    have = s.get(key)
    if have is None:
        have = 0.0
    if key in ("max_dd", "worst_loss", "profit_factor") and not s["trades"]:
        ok = False
    elif key in LOWER_IS_BETTER:
        ok = have <= need
    else:
        ok = have >= need
    label, now = CHECK_TEXT[key]
    return {"key": key, "label": label.format(v=need), "now": now.format(a=have), "ok": ok}


def passport(s: dict) -> dict:
    """The highest level whose checks all pass (levels build on each other), and the checks for the next."""
    level, nxt = None, None
    for lv in LEVELS:
        checks = [_check(k, v, s) for k, v in lv["checks"]]
        info = {"key": lv["key"], "name": lv["name"], "title": lv["title"], "blurb": lv["blurb"], "checks": checks,
                "done": sum(ch["ok"] for ch in checks), "total": len(checks)}
        if all(ch["ok"] for ch in checks) and nxt is None:
            level = info
        elif nxt is None:
            nxt = info
    return {"level": level, "next": nxt, "levels": [{k: lv[k] for k in ("key", "name", "title", "blurb")} for lv in LEVELS]}


def _trade_rows(rows: list[dict]) -> list[dict]:
    out = []
    for e in rows:
        if e["kind"] != "trade":
            continue
        t = e["data"]
        out.append({"seq": e["seq"], "symbol": t["symbol"], "side": t["side"], "opened_at": t["opened_at"],
                    "closed_at": t["closed_at"], "entry_price": t["entry_price"], "exit_price": t["exit_price"],
                    "stop": t.get("stop_loss") is not None, "agent": t.get("agent", False),
                    "pct": round((t["pnl"] or 0) / t["balance_before"] * 100, 3) if t.get("balance_before") else 0.0,
                    "reason": t.get("reason")})
    return out[-MAX_REPORT_TRADES:][::-1]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class IssueIn(BaseModel):
    display_name: str = Field("", max_length=60)


def _sync(user_id: int) -> None:
    from . import paper  # app.paper calls into this module
    with db.conn() as c:
        paper.sync(c, user_id)


def _report_out(r: dict) -> dict:
    return {"id": r["id"], "display_name": r["display_name"], "issued_at": r["issued_at"], "upto_seq": r["upto_seq"],
            "head_hash": r["head_hash"], "revoked": r["revoked_at"] is not None,
            "level": (r["snapshot"]["passport"]["level"] or {}).get("name"), "trades": r["snapshot"]["stats"]["trades"]}


@router.get("")
def overview(user: UserOut = Depends(current_user)):
    _sync(user.id)
    with db.conn() as c:
        rows = entries(c, user.id)
        reports = c.execute("SELECT * FROM record_reports WHERE user_id = %s ORDER BY issued_at DESC", (user.id,)).fetchall()
    chain = check_chain(rows)
    s = stats(rows)
    return {"stats": s, "passport": passport(s), "chain": chain,
            "recent": [{"seq": e["seq"], "kind": e["kind"], "at": e["data"].get("at"), "hash": e["hash"],
                        "prev_hash": e["prev_hash"], "summary": _summary(e)} for e in rows[-12:][::-1]],
            "reports": [_report_out(r) for r in reports]}


def _summary(e: dict) -> str:
    d = e["data"]
    if e["kind"] == "start":
        return f"Record opened at ${d['balance']:,.2f}"
    if e["kind"] == "reset":
        return f"Account started over at ${d['balance']:,.2f}"
    if e["kind"] == "funds":
        return f"{'Added' if d['amount'] >= 0 else 'Took out'} ${abs(d['amount']):,.2f}"
    if e["kind"] == "prop":
        return f"Prop challenge {d['result']} (${d['size']:,.0f} {d['plan']})"
    who = " by the agent" if d.get("agent") else ""
    return f"{d['side'].title()} {d['symbol']} closed{who}, {'+' if d['pnl'] >= 0 else '-'}${abs(d['pnl']):,.2f}"


@router.post("/reports", status_code=201)
def issue(body: IssueIn, user: UserOut = Depends(current_user)):
    _sync(user.id)
    with db.conn() as c:
        rows = entries(c, user.id)
        chain = check_chain(rows)
        if not chain["ok"]:
            raise HTTPException(409, "The record's ledger doesn't check out, so a report can't be issued. Contact support.")
        s = stats(rows)
        if not s["trades"]:
            raise HTTPException(422, "Close at least one paper trade of your own before issuing a report")
        name = body.display_name.strip() or "A Trading Lab trader"
        rid = secrets.token_urlsafe(9)
        issued = datetime.now(timezone.utc)
        snapshot = json.loads(canonical({"stats": s, "passport": passport(s), "trades": _trade_rows(rows),
                                         "entries": len(rows)}))
        sig = sign(_message(rid, user.id, name, _iso(issued), len(rows), chain["head"], snapshot))
        c.execute("""INSERT INTO record_reports (id, user_id, display_name, issued_at, upto_seq, head_hash, snapshot, signature)
                     VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                  (rid, user.id, name, issued, len(rows), chain["head"], Jsonb(snapshot), sig))
        r = c.execute("SELECT * FROM record_reports WHERE id = %s", (rid,)).fetchone()
    return _report_out(r)


def _message(rid: str, user_id: int, name: str, issued: str, upto: int, head: str, snapshot: dict) -> bytes:
    return canonical({"id": rid, "user": user_id, "name": name, "issued_at": issued, "upto": upto, "head": head,
                      "snapshot": hashlib.sha256(canonical(snapshot)).hexdigest()})


@router.delete("/reports/{rid}", status_code=204)
def revoke(rid: str, user: UserOut = Depends(current_user)):
    with db.conn() as c:
        r = c.execute("UPDATE record_reports SET revoked_at = now() WHERE id = %s AND user_id = %s AND revoked_at IS NULL "
                      "RETURNING id", (rid, user.id)).fetchone()
    if not r:
        raise HTTPException(404, "Report not found")


@router.get("/verify/{rid}")
def verify(rid: str):
    """Public: anyone with the link can check a report. No sign-in, and no email or account id is shown."""
    with db.conn() as c:
        r = c.execute("SELECT * FROM record_reports WHERE id = %s", (rid,)).fetchone()
        if not r:
            raise HTTPException(404, "No report with this link")
        if r["revoked_at"] is not None:
            return {"id": rid, "status": "revoked", "display_name": r["display_name"], "issued_at": r["issued_at"]}
        rows = entries(c, r["user_id"], r["upto_seq"])
    chain = check_chain(rows)
    sig_ok = hmac.compare_digest(r["signature"], sign(_message(
        rid, r["user_id"], r["display_name"], _iso(r["issued_at"]), r["upto_seq"], r["head_hash"], r["snapshot"])))
    # The stats are recomputed from the ledger too, so a snapshot can't claim more than the trades show.
    recomputed_ok = chain["ok"] and json.loads(canonical(stats(rows))) == r["snapshot"]["stats"]
    ok = chain["ok"] and chain["entries"] == r["upto_seq"] and chain["head"] == r["head_hash"] and sig_ok and recomputed_ok
    snap = r["snapshot"]
    return {
        "id": rid, "status": "verified" if ok else "altered",
        "display_name": r["display_name"], "issued_at": r["issued_at"],
        "checks": {"chain": chain["ok"] and chain["head"] == r["head_hash"], "signature": sig_ok, "stats": recomputed_ok},
        "entries": r["upto_seq"], "head_hash": r["head_hash"],
        "stats": snap["stats"], "passport": snap["passport"], "trades": snap["trades"],
    }
