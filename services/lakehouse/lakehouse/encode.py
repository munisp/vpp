"""Turning rows into the bytes that land in the lake.

Parquet, not the previous JSON Lines: the point of the lakehouse is that a
training job or a query engine can read a column out of a partition without
parsing every record, and JSONL gives neither the columns nor the types.

Two deliberate normalisations, both to stop schema inference from making the
files unreadable later:

* `jsonb` and `text` columns holding JSON (`payload`, `metadata`) are written as
  JSON *strings*. Inferring a struct from one batch's payloads produces a
  different Parquet schema per batch, and a reader that unions them fails.
* Everything is written under an explicit schema derived from the first batch's
  Python types, so a column that is entirely NULL in one batch does not become a
  null-typed column that conflicts with the next.
"""

from __future__ import annotations

import datetime as dt
import decimal
import hashlib
import json
from typing import Any, Mapping, Sequence

import pyarrow as pa
import pyarrow.parquet as pq


def _normalise(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, default=str)
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    return value


def _arrow_type(values: Sequence[Any]) -> pa.DataType:
    for value in values:
        if value is None:
            continue
        if isinstance(value, bool):
            return pa.bool_()
        if isinstance(value, int):
            return pa.int64()
        if isinstance(value, float):
            return pa.float64()
        if isinstance(value, dt.datetime):
            return pa.timestamp("us")
        if isinstance(value, dt.date):
            return pa.date32()
        return pa.string()
    # Every value in this batch is NULL. String keeps the column readable and
    # unioned with a later batch that does have values.
    return pa.string()


def to_parquet(rows: Sequence[Mapping[str, Any]]) -> bytes:
    """Encode rows as a single Parquet file. Raises on an empty batch: an empty
    object in the lake is indistinguishable from a dataset with no data."""
    if not rows:
        raise ValueError("refusing to encode an empty batch")

    columns = list(rows[0].keys())
    data: dict[str, list[Any]] = {column: [] for column in columns}
    for row in rows:
        for column in columns:
            data[column].append(_normalise(row.get(column)))

    fields = []
    for column in columns:
        arrow_type = _arrow_type(data[column])
        if arrow_type == pa.string():
            data[column] = [None if v is None else str(v) for v in data[column]]
        fields.append(pa.field(column, arrow_type))

    table = pa.Table.from_pydict(data, schema=pa.schema(fields))
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink, compression="snappy")
    return sink.getvalue().to_pybytes()


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()
