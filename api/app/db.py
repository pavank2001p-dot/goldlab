from contextlib import contextmanager
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from . import config

_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            config.DATABASE_URL, min_size=1, max_size=10, kwargs={"row_factory": dict_row}, open=True
        )
    return _pool


def close() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def conn():
    with pool().connection() as c:
        yield c


def migrate() -> None:
    sql = (Path(__file__).parent / "schema.sql").read_text()
    with conn() as c:
        c.execute(sql)


def get_meta(key: str) -> str | None:
    with conn() as c:
        row = c.execute("SELECT value FROM meta WHERE key = %s", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(key: str, value: str) -> None:
    with conn() as c:
        c.execute(
            """INSERT INTO meta (key, value) VALUES (%s, %s)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""",
            (key, value),
        )
