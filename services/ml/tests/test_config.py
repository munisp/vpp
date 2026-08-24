"""The trainer's data source must be PostgreSQL, and must say so at load."""

from __future__ import annotations

import pytest

from vppml.config import ConfigError, load_config

ENV_NAMES = (
    "ML_DATABASE_URL",
    "DATABASE_URL",
    "ML_ARTIFACT_DIR",
    "LAKEHOUSE_STORE",
    "RAY_ADDRESS",
)


def _clear(monkeypatch) -> None:
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


def test_a_dsn_for_another_database_is_refused_not_trained_from(monkeypatch) -> None:
    # psycopg would take this URL and fail when a statement runs, so a run
    # would look like a database outage rather than a mis-set variable.
    _clear(monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "mysql://vpp:vpp@localhost:3306/vpp")
    monkeypatch.setenv("ML_ARTIFACT_DIR", "/tmp/artifacts")

    with pytest.raises(ConfigError, match="only in PostgreSQL"):
        load_config()

    monkeypatch.setenv("ML_DATABASE_URL", "mysql://vpp@localhost/vpp")
    with pytest.raises(ConfigError, match="ML_DATABASE_URL"):
        load_config()

    monkeypatch.setenv("ML_DATABASE_URL", "postgresql://localhost/vpp_ml")
    assert load_config().dsn == "postgresql://localhost/vpp_ml"
