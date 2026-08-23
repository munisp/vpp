"""The pipeline against a real PostgreSQL.

Requires `LAKEHOUSE_TEST_DSN`. These tests are the only place the ordering
guarantee — object verified *before* the watermark moves — is actually exercised,
so they run in CI against a real server rather than a mock connection.
"""

from __future__ import annotations

import datetime as dt
import io
import os
import pathlib

import psycopg2
import pyarrow.parquet as pq
import pytest

from lakehouse.config import Config, FileStore
from lakehouse.datasets import Dataset
from lakehouse.pipeline import LOCK_NAMESPACE, _lock_key, ingest_dataset
from lakehouse.store import LocalStore, StoreError, StoredObject

DSN = os.getenv("LAKEHOUSE_TEST_DSN", "").strip()
pytestmark = pytest.mark.skipif(not DSN, reason="LAKEHOUSE_TEST_DSN is not set")

MIGRATION = (
    pathlib.Path(__file__).resolve().parents[3]
    / "drizzle"
    / "migrations"
    / "0015_lakehouse_ingestion.sql"
)

SOURCE = Dataset(
    name="pipeline_test_rows",
    table="pipeline_test_rows",
    change_column="changed_at",
    id_column="id",
    columns=("id", "label", "amount", "changed_at"),
    mutable=True,
    description="Fixture table standing in for a platform table.",
)


class RefusingStore:
    """An object store that is up but will not accept the write."""

    def put(self, key: str, body: bytes) -> StoredObject:
        raise StoreError(f"s3://lake/{key}: connection refused")

    def describe(self) -> str:
        return "refusing"


@pytest.fixture()
def connection():
    conn = psycopg2.connect(DSN)
    with conn.cursor() as cursor:
        cursor.execute("DROP TABLE IF EXISTS lakehouse_runs, lakehouse_watermarks")
        cursor.execute("DROP TYPE IF EXISTS lakehouse_run_state")
        cursor.execute(MIGRATION.read_text())
        cursor.execute("DROP TABLE IF EXISTS pipeline_test_rows")
        cursor.execute(
            """
            CREATE TABLE pipeline_test_rows (
              id serial PRIMARY KEY,
              label varchar(32) NOT NULL,
              amount integer NOT NULL,
              changed_at timestamp NOT NULL DEFAULT now()
            )
            """
        )
    conn.commit()
    yield conn
    conn.close()


@pytest.fixture()
def config(tmp_path) -> Config:
    return Config(
        dsn=DSN,
        store=FileStore(root=str(tmp_path), prefix="vpp"),
        batch_rows=2,
        freshness_seconds=3600,
        runner="pytest",
    )


@pytest.fixture()
def store(config) -> LocalStore:
    return LocalStore(config.store)


def _insert(connection, rows: list[tuple[str, int, dt.datetime]]) -> None:
    with connection.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO pipeline_test_rows (label, amount, changed_at) VALUES (%s, %s, %s)", rows
        )
    connection.commit()


def _watermark(connection) -> tuple:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT watermark_at, watermark_id, rows_ingested FROM lakehouse_watermarks "
            "WHERE dataset = %s",
            (SOURCE.name,),
        )
        return cursor.fetchone()


def _runs(connection) -> list[tuple]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT state, rows_written, object_key, error FROM lakehouse_runs ORDER BY id"
        )
        return cursor.fetchall()


def test_ingests_in_batches_and_advances_the_watermark(connection, store, config, tmp_path) -> None:
    base = dt.datetime(2026, 8, 22, 9, 0, 0)
    _insert(
        connection,
        [("a", 1, base), ("b", 2, base + dt.timedelta(minutes=1)),
         ("c", 3, base + dt.timedelta(minutes=2))],
    )

    result = ingest_dataset(connection, store, SOURCE, config)

    assert result.state == "succeeded"
    assert (result.rows, result.batches) == (3, 2)  # batch_rows=2
    assert _watermark(connection)[:3] == (base + dt.timedelta(minutes=2), 3, 3)

    written = sorted(p for p in (tmp_path / "vpp" / SOURCE.name).rglob("*.parquet"))
    assert len(written) == 2
    labels: list[str] = []
    for path in written:
        labels.extend(pq.read_table(io.BytesIO(path.read_bytes())).to_pydict()["label"])
    assert sorted(labels) == ["a", "b", "c"]


def test_a_second_pass_with_no_new_rows_is_empty_not_a_successful_load(
    connection, store, config
) -> None:
    _insert(connection, [("a", 1, dt.datetime(2026, 8, 22, 9, 0, 0))])
    ingest_dataset(connection, store, SOURCE, config)

    again = ingest_dataset(connection, store, SOURCE, config)

    assert (again.state, again.rows, again.objects) == ("empty", 0, [])
    assert [row[0] for row in _runs(connection)][-1] == "empty"


def test_a_refused_store_records_a_failed_run_and_leaves_the_watermark(
    connection, config
) -> None:
    _insert(connection, [("a", 1, dt.datetime(2026, 8, 22, 9, 0, 0))])

    result = ingest_dataset(connection, RefusingStore(), SOURCE, config)

    assert result.state == "failed"
    assert "connection refused" in (result.error or "")
    state, rows_written, object_key, error = _runs(connection)[-1]
    assert (state, rows_written, object_key) == ("failed", 0, None)
    assert "connection refused" in error
    assert _watermark(connection)[:2] == (None, None)


def test_rows_sharing_one_instant_are_not_skipped(connection, store, config) -> None:
    instant = dt.datetime(2026, 8, 22, 9, 0, 0)
    _insert(connection, [("a", 1, instant), ("b", 2, instant), ("c", 3, instant)])

    first = ingest_dataset(connection, store, SOURCE, config)
    assert first.rows == 3
    assert _watermark(connection)[:2] == (instant, 3)

    _insert(connection, [("d", 4, instant)])
    later = ingest_dataset(connection, store, SOURCE, config)

    assert later.rows == 1


def test_a_mutable_row_is_ingested_again_as_a_new_version(connection, store, config) -> None:
    first_seen = dt.datetime(2026, 8, 22, 9, 0, 0)
    _insert(connection, [("pending", 1, first_seen)])
    ingest_dataset(connection, store, SOURCE, config)

    changed = first_seen + dt.timedelta(minutes=5)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE pipeline_test_rows SET label = 'completed', changed_at = %s WHERE id = 1",
            (changed,),
        )
    connection.commit()

    result = ingest_dataset(connection, store, SOURCE, config)

    assert result.rows == 1
    assert _watermark(connection)[:3] == (changed, 1, 2)


def test_a_concurrent_runner_is_skipped_rather_than_writing_the_same_rows_twice(
    connection, store, config
) -> None:
    _insert(connection, [("a", 1, dt.datetime(2026, 8, 22, 9, 0, 0))])
    holder = psycopg2.connect(DSN)
    try:
        with holder.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_lock(%s, %s)", (LOCK_NAMESPACE, _lock_key(SOURCE.name))
            )
        holder.commit()

        result = ingest_dataset(connection, store, SOURCE, config)
    finally:
        holder.close()

    assert result.state == "skipped_locked"
    assert _runs(connection) == []
    assert _watermark(connection) is None


def test_backlog_counts_what_is_not_yet_in_the_lake(connection, store, config) -> None:
    base = dt.datetime(2026, 8, 22, 9, 0, 0)
    _insert(connection, [("a", 1, base), ("b", 2, base + dt.timedelta(minutes=1))])
    config = Config(
        dsn=config.dsn,
        store=config.store,
        batch_rows=1,
        freshness_seconds=config.freshness_seconds,
        runner=config.runner,
    )

    ingest_dataset(connection, store, SOURCE, config, max_batches=1)
    watermark_at, watermark_id, _ = _watermark(connection)

    with connection.cursor() as cursor:
        cursor.execute(SOURCE.backlog_sql(), (watermark_at, watermark_id))
        behind = cursor.fetchone()[0]
    assert behind == 1
