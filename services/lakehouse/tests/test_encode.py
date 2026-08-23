"""What lands in the lake must be readable, and an empty batch must not land."""

from __future__ import annotations

import datetime as dt
import decimal
import io
import json

import pyarrow.parquet as pq
import pytest

from lakehouse.encode import digest, to_parquet


def _read(body: bytes) -> dict[str, list]:
    return pq.read_table(io.BytesIO(body)).to_pydict()


def test_round_trips_every_column_type_the_platform_stores() -> None:
    rows = [
        {
            "id": 1,
            "assetId": 7,
            "power": 1500,
            "voltage": None,
            "created_at": dt.datetime(2026, 8, 22, 10, 30, 0),
            "state": "completed",
            "rate": decimal.Decimal("2.50"),
            "ok": True,
        },
        {
            "id": 2,
            "assetId": 7,
            "power": -400,
            "voltage": 239,
            "created_at": dt.datetime(2026, 8, 22, 10, 31, 0),
            "state": "pending",
            "rate": decimal.Decimal("2.75"),
            "ok": False,
        },
    ]

    table = _read(to_parquet(rows))

    assert table["id"] == [1, 2]
    assert table["power"] == [1500, -400]
    assert table["voltage"] == [None, 239]
    assert table["created_at"][1] == dt.datetime(2026, 8, 22, 10, 31, 0)
    assert table["state"] == ["completed", "pending"]
    assert table["rate"] == [2.5, 2.75]
    assert table["ok"] == [True, False]


def test_writes_json_columns_as_strings_so_batches_share_one_schema() -> None:
    first = to_parquet([{"id": 1, "payload": {"topic": "trades.created", "amount": 100}}])
    second = to_parquet([{"id": 2, "payload": {"different": ["shape"]}}])

    assert pq.read_schema(io.BytesIO(first)) == pq.read_schema(io.BytesIO(second))
    assert json.loads(_read(first)["payload"][0]) == {"amount": 100, "topic": "trades.created"}


def test_a_column_that_is_null_throughout_stays_readable() -> None:
    body = to_parquet([{"id": 1, "temperature": None}, {"id": 2, "temperature": None}])

    assert _read(body)["temperature"] == [None, None]
    assert str(pq.read_schema(io.BytesIO(body)).field("temperature").type) == "string"


def test_refuses_to_encode_an_empty_batch() -> None:
    # An empty object in the lake reads as "this dataset has no data", which is a
    # different claim from "this run found no new rows".
    with pytest.raises(ValueError, match="empty batch"):
        to_parquet([])


def test_digest_is_content_addressed() -> None:
    assert digest(b"abc") == digest(b"abc")
    assert digest(b"abc") != digest(b"abd")
