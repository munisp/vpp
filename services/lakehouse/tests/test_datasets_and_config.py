"""Dataset ordering, projection and configuration refusals."""

from __future__ import annotations

import pytest

from lakehouse.config import ConfigError, FileStore, S3Store, load_config
from lakehouse.datasets import BY_NAME, DATASETS, selected


def test_every_dataset_orders_by_change_column_then_id() -> None:
    # Two rows sharing one change instant must not let a timestamp-only watermark
    # skip whichever landed second.
    for dataset in DATASETS:
        sql = dataset.select_sql(resume=True)
        assert f'("{dataset.change_column}", ' not in sql  # columns stay table-qualified
        assert f'ORDER BY {dataset.table}."{dataset.change_column}", ' in sql
        assert f'{dataset.table}."{dataset.id_column}"' in sql
        assert "> (%s, %s)" in sql
        assert sql.rstrip().endswith("LIMIT %s")


def test_a_first_run_takes_only_a_limit() -> None:
    sql = BY_NAME["telemetry"].select_sql(resume=False)
    assert "WHERE" not in sql
    assert sql.count("%s") == 1


def test_the_lake_never_receives_payment_contact_details() -> None:
    payments = BY_NAME["payments"]
    assert "phoneNumber" not in payments.columns
    assert "accountNumber" not in payments.columns
    assert payments.mutable is True
    assert payments.change_column == "updatedAt"


def test_append_only_datasets_are_not_ingested_as_versions() -> None:
    for name in ("telemetry", "settlement_events", "event_inbox"):
        assert BY_NAME[name].mutable is False


def test_an_unknown_dataset_is_refused_rather_than_quietly_dropped() -> None:
    with pytest.raises(KeyError, match="unknown dataset"):
        selected(["telemetry", "invoices"])
    assert selected([]) == DATASETS
    assert selected(["trades"]) == (BY_NAME["trades"],)


def _clear(monkeypatch) -> None:
    for name in (
        "LAKEHOUSE_DATABASE_URL",
        "DATABASE_URL",
        "LAKEHOUSE_STORE",
        "LAKEHOUSE_BUCKET",
        "LAKEHOUSE_LOCAL_PATH",
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
        "S3_ENDPOINT",
        "LAKEHOUSE_BATCH_ROWS",
    ):
        monkeypatch.delenv(name, raising=False)


def test_s3_mode_refuses_to_start_without_a_bucket_and_credentials(monkeypatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgres://localhost/vpp")

    with pytest.raises(ConfigError, match="LAKEHOUSE_BUCKET is required"):
        load_config()

    monkeypatch.setenv("LAKEHOUSE_BUCKET", "vpp-lake")
    with pytest.raises(ConfigError, match="S3_ACCESS_KEY is required"):
        load_config()


def test_the_local_store_is_a_named_choice_never_a_fallback(monkeypatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgres://localhost/vpp")
    monkeypatch.setenv("LAKEHOUSE_STORE", "file")

    with pytest.raises(ConfigError, match="LAKEHOUSE_LOCAL_PATH is required"):
        load_config()

    monkeypatch.setenv("LAKEHOUSE_LOCAL_PATH", "/tmp/lake")
    assert isinstance(load_config().store, FileStore)


def test_an_unknown_store_kind_is_not_guessed(monkeypatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgres://localhost/vpp")
    monkeypatch.setenv("LAKEHOUSE_STORE", "hdfs")

    with pytest.raises(ConfigError, match="is not 's3' or 'file'"):
        load_config()


def test_a_nonsense_batch_size_stops_the_job(monkeypatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgres://localhost/vpp")
    monkeypatch.setenv("LAKEHOUSE_STORE", "s3")
    monkeypatch.setenv("LAKEHOUSE_BUCKET", "vpp-lake")
    monkeypatch.setenv("S3_ACCESS_KEY", "key")
    monkeypatch.setenv("S3_SECRET_KEY", "secret")
    assert isinstance(load_config().store, S3Store)

    monkeypatch.setenv("LAKEHOUSE_BATCH_ROWS", "0")
    with pytest.raises(ConfigError, match="must be greater than zero"):
        load_config()
