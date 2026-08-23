"""Reading training data out of the lake, with the provenance the reader can prove.

The ingestion job records one row per object it wrote in `lakehouse_runs`,
including the object's SHA-256 at write time. This module reads only objects
recorded by a `succeeded` run, re-hashes every one of them, and aborts the whole
read if a single object is missing or no longer matches.

That refusal is the point. A trainer that skipped an unreadable object would
train on a subset of the window while recording the whole window as its
provenance — the model's training set and its stated training set would differ,
and nothing downstream could tell.
"""

from __future__ import annotations

import hashlib
import io
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from .config import LakeAccess


class LakeError(RuntimeError):
    """The lake cannot be read, or does not hold what it recorded holding."""


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


class LakeReader:
    """Reads recorded object keys. Keys are used exactly as recorded, because that
    is what the ingestion job wrote and what the digest belongs to."""

    def __init__(self, access: LakeAccess) -> None:
        self._access = access
        self._client: Any = None
        if access.kind == "s3":
            import boto3  # noqa: PLC0415 - optional dependency for the file store

            self._client = boto3.client(
                "s3",
                endpoint_url=access.endpoint,
                aws_access_key_id=access.access_key,
                aws_secret_access_key=access.secret_key,
                region_name=access.region,
            )

    def describe(self) -> str:
        return self._access.describe()

    def get(self, key: str) -> bytes:
        if self._access.kind == "file":
            assert self._access.root is not None
            path = os.path.join(self._access.root, key)
            if not os.path.exists(path):
                raise LakeError(f"{path} does not exist")
            try:
                with open(path, "rb") as handle:
                    return handle.read()
            except OSError as exc:
                raise LakeError(f"reading {path}: {exc}") from exc

        from botocore.exceptions import BotoCoreError, ClientError  # noqa: PLC0415

        try:
            return self._client.get_object(Bucket=self._access.bucket, Key=key)["Body"].read()
        except (ClientError, BotoCoreError) as exc:
            raise LakeError(f"s3://{self._access.bucket}/{key}: {exc}") from exc


@dataclass
class LakeExtract:
    """Rows read from the lake, and exactly which objects they came from."""

    dataset: str
    window_start: datetime
    window_end: datetime
    columns: dict[str, list[Any]] = field(default_factory=dict)
    object_keys: list[str] = field(default_factory=list)
    object_digests: list[str] = field(default_factory=list)

    @property
    def rows(self) -> int:
        if not self.columns:
            return 0
        return len(next(iter(self.columns.values())))


def _read_parquet(body: bytes) -> dict[str, list[Any]]:
    import pyarrow.parquet as pq  # noqa: PLC0415 - heavy import, only needed here

    table = pq.read_table(io.BytesIO(body))
    return {name: table.column(name).to_pylist() for name in table.column_names}


def recorded_objects(
    connection: Any, dataset: str, window_start: datetime, window_end: datetime
) -> list[tuple[str, str, int]]:
    """(key, digest, rows) for every object a succeeded run wrote in the window."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT object_key, object_digest, rows_written
              FROM lakehouse_runs
             WHERE dataset = %s AND state = 'succeeded'
               AND object_key IS NOT NULL
               AND finished_at >= %s AND finished_at < %s
             ORDER BY id
            """,
            (dataset, window_start, window_end),
        )
        return [(row[0], row[1], int(row[2] or 0)) for row in cursor.fetchall()]


def extract(
    connection: Any,
    reader: LakeReader,
    dataset: str,
    window_start: datetime,
    window_end: datetime,
    *,
    required_columns: Optional[tuple[str, ...]] = None,
) -> LakeExtract:
    """Read a dataset's objects for the window, verifying every one.

    Raises `LakeError` when the window holds no succeeded run, when an object
    cannot be read, when its bytes no longer match the recorded digest, or when a
    required column is absent — never returning a partial read as a whole one.
    """
    objects = recorded_objects(connection, dataset, window_start, window_end)
    if not objects:
        raise LakeError(
            f"no succeeded ingestion run for {dataset} between {window_start.isoformat()} and "
            f"{window_end.isoformat()}: there is nothing in the lake to train on for that window"
        )

    result = LakeExtract(dataset=dataset, window_start=window_start, window_end=window_end)
    for key, recorded_digest, _rows in objects:
        body = reader.get(key)
        actual = digest(body)
        if actual != recorded_digest:
            raise LakeError(
                f"{dataset}: object {key} digests to {actual} but the run recorded "
                f"{recorded_digest}; the lake changed under this training set"
            )
        for name, values in _read_parquet(body).items():
            result.columns.setdefault(name, []).extend(values)
        result.object_keys.append(key)
        result.object_digests.append(actual)

    if required_columns:
        missing = [column for column in required_columns if column not in result.columns]
        if missing:
            raise LakeError(
                f"{dataset}: objects in the window do not carry {', '.join(missing)}; "
                "a training set cannot be built from columns that are not there"
            )
    return result
