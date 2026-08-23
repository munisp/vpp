"""Fixtures for the tests that need the real schema.

The registry, the job queue and `FOR UPDATE SKIP LOCKED` are all database
behaviour: a fake connection would assert that this module's SQL strings have not
changed, not that Postgres accepts them, which is how an invalid enum value or a
missing `RETURNING` reaches production. These tests therefore run against a live
database with every platform migration applied, or they skip.

    createdb vpp_ml_test
    for f in drizzle/migrations/0*.sql; do psql -v ON_ERROR_STOP=1 \
        postgres://vpp:vpp@127.0.0.1:5432/vpp_ml_test -f "$f"; done
    ML_TEST_DSN=postgres://vpp:vpp@127.0.0.1:5432/vpp_ml_test pytest
"""

from __future__ import annotations

import os

import pytest

from vppml.config import Config

DEFAULT_DSN = "postgres://vpp:vpp@127.0.0.1:5432/vpp_ml_test"

#: Emptied before each test, children first.
ML_TABLES = (
    "model_feature_baselines",
    "retraining_jobs",
    "model_predictions",
    "training_runs",
    "model_registry",
    "training_datasets",
    "telemetry",
    "grid_node_assets",
    "grid_nodes",
    "assets",
    "lakehouse_runs",
)


def _dsn() -> str:
    return os.getenv("ML_TEST_DSN", "").strip() or DEFAULT_DSN


@pytest.fixture(scope="session")
def dsn():
    psycopg2 = pytest.importorskip("psycopg2")
    dsn = _dsn()
    try:
        connection = psycopg2.connect(dsn)
    except Exception as exc:  # noqa: BLE001 - no database here is a skip, not a failure
        pytest.skip(f"no test database at {dsn}: {exc}")
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('training_runs'), to_regclass('retraining_jobs')")
        present = cursor.fetchone()
    connection.close()
    if not all(present):
        pytest.skip(f"{dsn} does not have the platform migrations applied")
    return dsn


@pytest.fixture()
def connection(dsn):
    import psycopg2

    connection = psycopg2.connect(dsn)
    with connection.cursor() as cursor:
        for table in ML_TABLES:
            cursor.execute(f"DELETE FROM {table}")
    connection.commit()
    try:
        yield connection
    finally:
        connection.close()


@pytest.fixture()
def config(dsn, tmp_path):
    return Config(
        dsn=dsn,
        artifact_dir=str(tmp_path / "artifacts"),
        lake=None,
        ray_address="local",
        runner="pytest",
    )
