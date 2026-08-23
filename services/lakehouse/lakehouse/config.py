"""Configuration for the lakehouse ingestion job.

Every value is required except where a default is genuinely safe. The job refuses
to start on a missing setting rather than defaulting to a local bucket nobody
reads, because an ingestion job that silently writes somewhere else is
indistinguishable from one that works.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


class ConfigError(RuntimeError):
    """A setting is missing or unusable. The job exits; it does not guess."""


def _require(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is required")
    return value


def _optional(name: str) -> Optional[str]:
    value = os.getenv(name, "").strip()
    return value or None


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name}={raw!r} is not an integer") from exc
    if value <= 0:
        raise ConfigError(f"{name}={value} must be greater than zero")
    return value


@dataclass(frozen=True)
class S3Store:
    """MinIO or S3. `endpoint` is None for AWS itself."""

    bucket: str
    prefix: str
    endpoint: Optional[str]
    access_key: str
    secret_key: str
    region: Optional[str]


@dataclass(frozen=True)
class FileStore:
    """A directory on disk.

    This exists for development and for the tests, and it is a deliberate,
    named choice (`LAKEHOUSE_STORE=file`): the job never falls back to it when S3
    is misconfigured, so "ingested" always means ingested where operators look.
    """

    root: str
    prefix: str


@dataclass(frozen=True)
class Config:
    dsn: str
    store: object  # S3Store | FileStore
    #: Rows per run per dataset. Bounds memory and the size of one object.
    batch_rows: int
    #: How long a dataset may go without a successful or empty run before the
    #: platform calls it stale. Read by the API server too, via the same name.
    freshness_seconds: int
    runner: str


def load_config() -> Config:
    dsn = os.getenv("LAKEHOUSE_DATABASE_URL", "").strip() or _require("DATABASE_URL")
    prefix = os.getenv("LAKEHOUSE_PREFIX", "vpp").strip().strip("/")

    kind = os.getenv("LAKEHOUSE_STORE", "s3").strip().lower()
    if kind == "file":
        store: object = FileStore(root=_require("LAKEHOUSE_LOCAL_PATH"), prefix=prefix)
    elif kind == "s3":
        store = S3Store(
            bucket=_require("LAKEHOUSE_BUCKET"),
            prefix=prefix,
            endpoint=_optional("S3_ENDPOINT"),
            access_key=_require("S3_ACCESS_KEY"),
            secret_key=_require("S3_SECRET_KEY"),
            region=_optional("S3_REGION"),
        )
    else:
        raise ConfigError(f"LAKEHOUSE_STORE={kind!r} is not 's3' or 'file'")

    return Config(
        dsn=dsn,
        store=store,
        batch_rows=_positive_int("LAKEHOUSE_BATCH_ROWS", 10_000),
        freshness_seconds=_positive_int("LAKEHOUSE_FRESHNESS_SECONDS", 3_600),
        runner=os.getenv("LAKEHOUSE_RUNNER", "").strip() or os.uname().nodename,
    )
