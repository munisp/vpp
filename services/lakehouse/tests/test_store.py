"""A store only reports success when the object reads back byte for byte."""

from __future__ import annotations

import os

import pytest

from lakehouse.config import FileStore
from lakehouse.encode import digest
from lakehouse.store import LocalStore, StoreError, open_store


def test_writes_the_object_and_reports_its_digest(tmp_path) -> None:
    store = LocalStore(FileStore(root=str(tmp_path), prefix="vpp"))

    stored = store.put("telemetry/change_date=2026-08-22/a.parquet", b"parquet-bytes")

    path = tmp_path / "vpp" / "telemetry" / "change_date=2026-08-22" / "a.parquet"
    assert path.read_bytes() == b"parquet-bytes"
    assert stored.digest == digest(b"parquet-bytes")
    assert stored.bytes_written == len(b"parquet-bytes")


def test_a_truncated_object_is_a_failure_not_a_load(tmp_path, monkeypatch) -> None:
    store = LocalStore(FileStore(root=str(tmp_path), prefix="vpp"))
    real_open = open

    def truncating_open(path, mode="r", *args, **kwargs):
        handle = real_open(path, mode, *args, **kwargs)
        if "r" in mode:
            class Truncated:
                def read(self, *_):
                    return handle.read()[:4]

                def __enter__(self):
                    return self

                def __exit__(self, *_):
                    handle.close()
                    return False

            return Truncated()
        return handle

    monkeypatch.setattr("builtins.open", truncating_open)

    with pytest.raises(StoreError) as failure:
        store.put("telemetry/a.parquet", b"parquet-bytes")

    assert "reads back as" in str(failure.value)
    assert "4 of 13 bytes" in str(failure.value)


def test_an_unwritable_destination_raises_rather_than_reporting_a_load(tmp_path) -> None:
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    os.chmod(blocked, 0o500)
    store = LocalStore(FileStore(root=str(blocked), prefix="vpp"))

    try:
        with pytest.raises(StoreError):
            store.put("telemetry/a.parquet", b"bytes")
    finally:
        os.chmod(blocked, 0o700)


def test_an_unknown_store_configuration_is_refused() -> None:
    with pytest.raises(StoreError, match="unsupported store"):
        open_store(object())
