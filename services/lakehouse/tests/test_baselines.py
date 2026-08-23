"""What a baseline is allowed to claim.

The tests that matter here are the refusals: an object that cannot be read, an
object whose bytes changed since the run recorded it, a metric whose column is
absent, and a window with no ingestion. Each must produce *no* baseline rather
than a number computed from part of the data.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import psycopg2
import pytest

from lakehouse.baselines import (
    BaselineError,
    compute_dataset_baselines,
    run,
    store_baselines,
)
from lakehouse.config import Config, FileStore
from lakehouse.datasets import BY_NAME
from lakehouse.encode import digest, to_parquet
from lakehouse.store import LocalStore, StoreError

DSN = os.getenv("LAKEHOUSE_TEST_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="LAKEHOUSE_TEST_DSN is not set")

WINDOW_END = datetime(2026, 8, 22, 12, 0, 0)
WINDOW_START = WINDOW_END - timedelta(hours=24)


@pytest.fixture()
def connection():
    conn = psycopg2.connect(DSN)
    with conn.cursor() as cursor:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS lakehouse_runs (
              id serial PRIMARY KEY,
              dataset varchar(80) NOT NULL,
              state varchar(20) NOT NULL,
              runner varchar(120) NOT NULL DEFAULT 'test',
              started_at timestamp NOT NULL DEFAULT now(),
              finished_at timestamp,
              rows_written integer NOT NULL DEFAULT 0,
              bytes_written bigint NOT NULL DEFAULT 0,
              object_key varchar(400),
              object_digest varchar(64),
              from_watermark_at timestamp,
              from_watermark_id bigint,
              to_watermark_at timestamp,
              to_watermark_id bigint,
              error varchar(2000)
            );
            CREATE TABLE IF NOT EXISTS lakehouse_baselines (
              id serial PRIMARY KEY,
              dataset varchar(80) NOT NULL,
              metric varchar(80) NOT NULL,
              unit varchar(40) NOT NULL,
              window_start timestamp NOT NULL,
              window_end timestamp NOT NULL,
              value double precision NOT NULL,
              sample_rows bigint NOT NULL,
              source_objects text[] NOT NULL,
              computed_at timestamp NOT NULL DEFAULT now(),
              runner varchar(120) NOT NULL,
              CONSTRAINT lakehouse_baselines_has_sample CHECK (sample_rows > 0),
              CONSTRAINT lakehouse_baselines_has_provenance CHECK (
                array_length(source_objects, 1) >= 1
              ),
              CONSTRAINT lakehouse_baselines_window_ordered CHECK (window_end > window_start)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS lakehouse_baselines_unique_window
              ON lakehouse_baselines (dataset, metric, window_start, window_end);
            """
        )
        cursor.execute("TRUNCATE lakehouse_runs, lakehouse_baselines")
    conn.commit()
    yield conn
    conn.close()


@pytest.fixture()
def store(tmp_path):
    return LocalStore(FileStore(root=str(tmp_path), prefix="vpp"))


def config_for(tmp_path) -> Config:
    return Config(
        dsn=DSN,
        store=FileStore(root=str(tmp_path), prefix="vpp"),
        batch_rows=10,
        freshness_seconds=3600,
        runner="test-runner",
    )


def telemetry_rows(count: int, *, power: float | None = 1500.0):
    return [
        {
            "id": index,
            "assetId": 1 + (index % 3),
            "timestamp": WINDOW_END - timedelta(minutes=index),
            "power": power,
            "energy": 10.0,
            "voltage": 230.0,
            "current": 6.5,
            "frequency": 50.0,
            "stateOfCharge": None,
            "temperature": 25.0,
            "createdAt": WINDOW_END - timedelta(minutes=index),
            "_change_at": WINDOW_END - timedelta(minutes=index),
            "_row_id": index,
        }
        for index in range(1, count + 1)
    ]


def record_run(connection, dataset: str, key: str, body_digest: str, rows: int, *, at=None):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO lakehouse_runs
              (dataset, state, runner, finished_at, rows_written, bytes_written,
               object_key, object_digest)
            VALUES (%s, 'succeeded', 'test', %s, %s, 1, %s, %s)
            """,
            (dataset, at or WINDOW_END - timedelta(hours=1), rows, key, body_digest),
        )
    connection.commit()


def ingest(store: LocalStore, connection, rows) -> str:
    body = to_parquet(rows)
    stored = store.put("telemetry/2026-08-22/part-1.parquet", body)
    record_run(connection, "telemetry", stored.key, stored.digest, len(rows))
    return stored.key


def test_computes_metrics_from_verified_objects(connection, store, tmp_path):
    ingest(store, connection, telemetry_rows(12))

    result = compute_dataset_baselines(
        connection, store, BY_NAME["telemetry"], WINDOW_START, WINDOW_END
    )

    assert result.sample_rows == 12
    assert len(result.source_objects) == 1
    assert result.values["samples_per_hour"][0] == pytest.approx(0.5)
    assert result.values["reporting_assets"][0] == 3.0
    assert result.values["mean_power_w"][0] == pytest.approx(1500.0)
    # Every stateOfCharge was null, so no mean is offered for it at all.
    assert "mean_soc" not in result.values
    assert result.values["missing_soc_share"][0] == 1.0

    written = store_baselines(connection, result, config_for(tmp_path).runner)
    assert written == len(result.values)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT sample_rows, array_length(source_objects, 1) FROM lakehouse_baselines LIMIT 1"
        )
        sample_rows, objects = cursor.fetchone()
    assert sample_rows == 12
    assert objects == 1


def test_no_ingestion_in_window_yields_no_baseline(connection, store, tmp_path):
    result = compute_dataset_baselines(
        connection, store, BY_NAME["telemetry"], WINDOW_START, WINDOW_END
    )

    assert result.sample_rows == 0
    assert result.values == {}
    assert "nothing to compute a baseline from" in result.detail
    assert store_baselines(connection, result, "test") == 0


def test_unreadable_object_refuses_rather_than_computing_from_the_rest(
    connection, store, tmp_path
):
    key = ingest(store, connection, telemetry_rows(6))
    record_run(connection, "telemetry", "telemetry/missing.parquet", digest(b"absent"), 6)

    with pytest.raises(BaselineError, match="cannot be read"):
        compute_dataset_baselines(
            connection, store, BY_NAME["telemetry"], WINDOW_START, WINDOW_END
        )
    assert key  # the readable object existed; the baseline is still refused


def test_changed_object_refuses(connection, store, tmp_path):
    rows = telemetry_rows(6)
    dataset = BY_NAME["telemetry"]
    stored = store.put("telemetry/2026-08-22/part-1.parquet", to_parquet(rows))
    # Record a digest that does not match what is in the store: the object was
    # rewritten after the run, which is exactly what must not be averaged.
    record_run(connection, "telemetry", stored.key, digest(b"something else"), len(rows))

    with pytest.raises(BaselineError, match="changed under this baseline"):
        compute_dataset_baselines(connection, store, dataset, WINDOW_START, WINDOW_END)


def test_missing_column_is_skipped_not_defaulted(connection, store, monkeypatch, tmp_path):
    ingest(store, connection, telemetry_rows(6))
    monkeypatch.setattr(
        "lakehouse.baselines._read_parquet",
        lambda body: {"_row_id": [1, 2, 3], "id": [1, 2, 3]},
    )

    result = compute_dataset_baselines(
        connection, store, BY_NAME["telemetry"], WINDOW_START, WINDOW_END
    )

    assert "mean_power_w" not in result.values
    assert "columns absent" in result.skipped["mean_power_w"]
    assert result.values["samples_per_hour"][0] == pytest.approx(0.125)


def test_run_marks_verification_failure_without_writing(connection, store, tmp_path):
    record_run(connection, "telemetry", "telemetry/missing.parquet", digest(b"absent"), 6)

    results = run(
        connection,
        store,
        config_for(tmp_path),
        datasets=(BY_NAME["telemetry"],),
        window_hours=24,
        now=WINDOW_END,
    )

    assert [result.verification_failed for result in results] == [True]
    with connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM lakehouse_baselines")
        assert cursor.fetchone()[0] == 0


def test_local_store_get_missing_object_raises(store):
    with pytest.raises(StoreError):
        store.get("telemetry/nope.parquet")
