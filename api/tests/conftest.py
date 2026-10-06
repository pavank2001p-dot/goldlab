import os

os.environ.setdefault("DATABASE_URL", "postgresql://gold:gold@localhost:5432/gold_test")

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        with db.conn() as conn:
            conn.execute("TRUNCATE users, candles, meta RESTART IDENTITY")
        yield c
