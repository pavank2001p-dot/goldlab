"""Small per-account settings kept on the server, so they follow the user to any device:
chart drawings and indicator choices. Paper trades, strategies and the risk profile already live
in their own tables."""

import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from . import db
from .auth import UserOut, current_user

router = APIRouter(prefix="/prefs", tags=["prefs"])

Key = Literal["drawings", "indicators", "chart_events", "trading"]  # trading: one-click and ticket choices
MAX_BYTES = 256 * 1024


class PrefIn(BaseModel):
    value: Any


@router.get("")
def all_(user: UserOut = Depends(current_user)):
    with db.conn() as c:
        rows = c.execute("SELECT key, value FROM user_prefs WHERE user_id = %s", (user.id,)).fetchall()
    return {r["key"]: r["value"] for r in rows}


@router.put("/{key}")
def put(key: Key, body: PrefIn, user: UserOut = Depends(current_user)):
    if len(json.dumps(body.value)) > MAX_BYTES:
        raise HTTPException(413, "That's too much to save. Remove some drawings first.")
    with db.conn() as c:
        c.execute(
            "INSERT INTO user_prefs (user_id, key, value) VALUES (%s, %s, %s) "
            "ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            (user.id, key, Jsonb(body.value)),
        )
    return {"ok": True}
