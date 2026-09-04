"""Apply db/migrations/*.sql forward-only, tracked in schema_migrations.

Usage:
    python db/apply.py "postgresql://..."           # or MAISTRO_DATABASE_URL
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def apply_migrations(database_url: str) -> list[str]:
    applied: list[str] = []
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "create table if not exists schema_migrations ("
            "  name text primary key, applied_at timestamptz not null default now())"
        )
        done = {
            row[0] for row in conn.execute("select name from schema_migrations").fetchall()
        }
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                continue
            with conn.transaction():
                conn.execute(path.read_text(encoding="utf-8"))  # type: ignore[arg-type]
                conn.execute(
                    "insert into schema_migrations (name) values (%s)", (path.name,)
                )
            applied.append(path.name)
    return applied


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MAISTRO_DATABASE_URL")
    if not url:
        raise SystemExit("usage: python db/apply.py <database-url>  (or set MAISTRO_DATABASE_URL)")
    names = apply_migrations(url)
    print(f"applied: {names or 'nothing (up to date)'}")
