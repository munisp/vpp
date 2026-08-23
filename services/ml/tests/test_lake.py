import os
from datetime import datetime

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from vppml import lake
from vppml.config import LakeAccess


START = datetime(2026, 3, 1)
END = datetime(2026, 3, 8)


class FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, *args):
        return None

    def fetchall(self):
        return self._rows


class FakeConnection:
    """Stands in for the `lakehouse_runs` rows the ingestion job wrote."""

    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        return FakeCursor(self._rows)


def write_object(root, key, rows=3, columns=("assetId", "timestamp", "power")):
    data = {
        "assetId": [1] * rows,
        "timestamp": [START] * rows,
        "power": [100 * index for index in range(rows)],
        "energy": [0] * rows,
        "stateOfCharge": [None] * rows,
    }
    table = pa.table({name: data[name] for name in columns if name in data})
    path = os.path.join(root, key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pq.write_table(table, path)
    with open(path, "rb") as handle:
        return lake.digest(handle.read())


def reader_for(root):
    return lake.LakeReader(
        LakeAccess(
            kind="file",
            bucket=None,
            root=str(root),
            endpoint=None,
            access_key=None,
            secret_key=None,
            region=None,
        )
    )


def test_a_verified_window_reads_every_recorded_object(tmp_path):
    first = write_object(tmp_path, "raw/telemetry/a.parquet")
    second = write_object(tmp_path, "raw/telemetry/b.parquet", rows=2)
    connection = FakeConnection(
        [("raw/telemetry/a.parquet", first, 3), ("raw/telemetry/b.parquet", second, 2)]
    )
    extract = lake.extract(connection, reader_for(tmp_path), "telemetry", START, END)
    assert extract.rows == 5
    assert extract.object_keys == ["raw/telemetry/a.parquet", "raw/telemetry/b.parquet"]
    assert extract.object_digests == [first, second]


def test_a_window_with_no_succeeded_run_is_refused(tmp_path):
    with pytest.raises(lake.LakeError, match="no succeeded ingestion run"):
        lake.extract(FakeConnection([]), reader_for(tmp_path), "telemetry", START, END)


def test_a_missing_object_refuses_the_whole_read(tmp_path):
    """A trainer that skipped the unreadable object would record the whole window as
    its provenance while training on part of it."""
    first = write_object(tmp_path, "raw/telemetry/a.parquet")
    connection = FakeConnection(
        [("raw/telemetry/a.parquet", first, 3), ("raw/telemetry/gone.parquet", "0" * 64, 3)]
    )
    with pytest.raises(lake.LakeError, match="does not exist"):
        lake.extract(connection, reader_for(tmp_path), "telemetry", START, END)


def test_an_object_whose_bytes_changed_is_refused(tmp_path):
    recorded = write_object(tmp_path, "raw/telemetry/a.parquet")
    write_object(tmp_path, "raw/telemetry/a.parquet", rows=7)  # rewritten under us
    connection = FakeConnection([("raw/telemetry/a.parquet", recorded, 3)])
    with pytest.raises(lake.LakeError, match="the lake changed under this training set"):
        lake.extract(connection, reader_for(tmp_path), "telemetry", START, END)


def test_a_window_missing_a_required_column_is_refused(tmp_path):
    digest = write_object(tmp_path, "raw/t/a.parquet", columns=("assetId", "timestamp"))
    connection = FakeConnection([("raw/t/a.parquet", digest, 3)])
    with pytest.raises(lake.LakeError, match="do not carry power"):
        lake.extract(
            connection,
            reader_for(tmp_path),
            "telemetry",
            START,
            END,
            required_columns=("assetId", "timestamp", "power"),
        )


def test_the_key_is_used_exactly_as_recorded(tmp_path):
    digest = write_object(tmp_path, "raw/telemetry/2026/03/01/a.parquet")
    connection = FakeConnection([("raw/telemetry/2026/03/01/a.parquet", digest, 3)])
    extract = lake.extract(connection, reader_for(tmp_path), "telemetry", START, END)
    assert extract.object_keys == ["raw/telemetry/2026/03/01/a.parquet"]
