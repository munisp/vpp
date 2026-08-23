"""Configuration for the training and inference service.

Nothing here has a convenience default that would let a run write a checkpoint
somewhere nobody reads, or train against a database nobody uses. A missing
setting raises and the process exits, because a training job that silently used
the wrong source produces a model that looks trained and is not.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


class ConfigError(RuntimeError):
    """A setting is missing or unusable."""


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
class LakeAccess:
    """How to read the objects `lakehouse_runs` recorded.

    Deliberately mirrors the ingestion job's settings so the trainer reads the
    same lake the job wrote, by the keys the job recorded.
    """

    kind: str  # 's3' | 'file'
    bucket: Optional[str]
    root: Optional[str]
    endpoint: Optional[str]
    access_key: Optional[str]
    secret_key: Optional[str]
    region: Optional[str]

    def describe(self) -> str:
        if self.kind == "file":
            return f"file://{self.root}"
        return f"{self.endpoint or 's3'}/{self.bucket}"


@dataclass(frozen=True)
class Config:
    dsn: str
    #: Where checkpoints are written. Must be readable by whatever serves the
    #: model, which is why promotion re-hashes the file rather than trusting the
    #: registry row.
    artifact_dir: str
    lake: Optional[LakeAccess]
    #: 'local' means this process trains in-process. Any other value is a Ray
    #: address that must actually connect; there is no silent local fallback.
    ray_address: str
    runner: str

    @property
    def uses_ray(self) -> bool:
        return self.ray_address != "local"


def load_lake_access() -> Optional[LakeAccess]:
    """None when the lake is not configured. A trainer asked for a lakehouse
    dataset then refuses, rather than reading the platform tables and labelling
    the result as lake-derived."""
    kind = os.getenv("LAKEHOUSE_STORE", "").strip().lower()
    if not kind:
        return None
    if kind == "file":
        return LakeAccess(
            kind="file",
            bucket=None,
            root=_require("LAKEHOUSE_LOCAL_PATH"),
            endpoint=None,
            access_key=None,
            secret_key=None,
            region=None,
        )
    if kind == "s3":
        return LakeAccess(
            kind="s3",
            bucket=_require("LAKEHOUSE_BUCKET"),
            root=None,
            endpoint=_optional("S3_ENDPOINT"),
            access_key=_require("S3_ACCESS_KEY"),
            secret_key=_require("S3_SECRET_KEY"),
            region=_optional("S3_REGION"),
        )
    raise ConfigError(f"LAKEHOUSE_STORE={kind!r} is not 's3' or 'file'")


def load_config() -> Config:
    dsn = os.getenv("ML_DATABASE_URL", "").strip() or _require("DATABASE_URL")
    return Config(
        dsn=dsn,
        artifact_dir=_require("ML_ARTIFACT_DIR"),
        lake=load_lake_access(),
        ray_address=os.getenv("RAY_ADDRESS", "").strip() or "local",
        runner=os.getenv("ML_RUNNER", "").strip() or os.uname().nodename,
    )
