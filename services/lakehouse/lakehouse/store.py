"""Where the bytes go, and how the job knows they arrived.

A `put` that returns without raising is not evidence that the object is readable:
the previous pipeline treated a successful call as a successful load, and treated
a failed one as a log line. Both stores here read the object back and compare the
SHA-256 of what came back with the SHA-256 of what was sent. A mismatch, a short
object or a missing one raises, the run is recorded as failed, and the watermark
does not move — so the next run re-reads exactly the rows that were not stored.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol

from .config import FileStore, S3Store
from .encode import digest


class StoreError(RuntimeError):
    """The object store refused, or returned something other than what was written."""


@dataclass(frozen=True)
class StoredObject:
    key: str
    bytes_written: int
    digest: str


class Store(Protocol):
    def put(self, key: str, body: bytes) -> StoredObject: ...

    def get(self, key: str) -> bytes: ...

    def describe(self) -> str: ...


class LocalStore:
    """A directory on disk, used by the tests and by local development."""

    def __init__(self, config: FileStore) -> None:
        self._root = config.root
        self._prefix = config.prefix

    def _path(self, key: str) -> str:
        return os.path.join(self._root, self._prefix, key)

    def put(self, key: str, body: bytes) -> StoredObject:
        path = self._path(key)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(body)
                handle.flush()
                os.fsync(handle.fileno())
            with open(path, "rb") as handle:
                written = handle.read()
        except OSError as exc:
            raise StoreError(f"writing {path}: {exc}") from exc

        expected = digest(body)
        actual = digest(written)
        if actual != expected:
            raise StoreError(
                f"{path} reads back as {actual} but {expected} was written "
                f"({len(written)} of {len(body)} bytes)"
            )
        return StoredObject(key=key, bytes_written=len(body), digest=expected)

    def get(self, key: str) -> bytes:
        """Read an object back. A missing or unreadable object raises: a reader that
        treated it as empty would compute a baseline from part of the data."""
        # Keys recorded by `put` are already prefixed relative to the root.
        path = os.path.join(self._root, key)
        if not os.path.exists(path):
            path = self._path(key)
        try:
            with open(path, "rb") as handle:
                return handle.read()
        except OSError as exc:
            raise StoreError(f"reading {path}: {exc}") from exc

    def describe(self) -> str:
        return f"file://{os.path.join(self._root, self._prefix)}"


class S3ObjectStore:
    """MinIO or S3. Imports boto3 lazily so the local store needs no AWS SDK."""

    def __init__(self, config: S3Store) -> None:
        import boto3  # noqa: PLC0415 - optional dependency for the file store

        self._bucket = config.bucket
        self._prefix = config.prefix
        self._endpoint = config.endpoint
        self._client = boto3.client(
            "s3",
            endpoint_url=config.endpoint,
            aws_access_key_id=config.access_key,
            aws_secret_access_key=config.secret_key,
            region_name=config.region,
        )

    def _key(self, key: str) -> str:
        return f"{self._prefix}/{key}" if self._prefix else key

    def put(self, key: str, body: bytes) -> StoredObject:
        from botocore.exceptions import BotoCoreError, ClientError  # noqa: PLC0415

        full_key = self._key(key)
        try:
            self._client.put_object(
                Bucket=self._bucket,
                Key=full_key,
                Body=body,
                ContentType="application/vnd.apache.parquet",
            )
            read_back = self._client.get_object(Bucket=self._bucket, Key=full_key)["Body"].read()
        except (ClientError, BotoCoreError) as exc:
            raise StoreError(f"s3://{self._bucket}/{full_key}: {exc}") from exc

        expected = digest(body)
        actual = digest(read_back)
        if actual != expected:
            raise StoreError(
                f"s3://{self._bucket}/{full_key} reads back as {actual} but {expected} "
                f"was written ({len(read_back)} of {len(body)} bytes)"
            )
        return StoredObject(key=full_key, bytes_written=len(body), digest=expected)

    def get(self, key: str) -> bytes:
        """Read an object back by the key `lakehouse_runs` recorded, which already
        includes the prefix."""
        from botocore.exceptions import BotoCoreError, ClientError  # noqa: PLC0415

        try:
            return self._client.get_object(Bucket=self._bucket, Key=key)["Body"].read()
        except (ClientError, BotoCoreError) as exc:
            raise StoreError(f"s3://{self._bucket}/{key}: {exc}") from exc

    def describe(self) -> str:
        location = self._endpoint or "s3"
        return f"{location}/{self._bucket}/{self._prefix}".rstrip("/")


def open_store(config: object) -> Store:
    if isinstance(config, FileStore):
        return LocalStore(config)
    if isinstance(config, S3Store):
        return S3ObjectStore(config)
    raise StoreError(f"unsupported store configuration {type(config).__name__}")
