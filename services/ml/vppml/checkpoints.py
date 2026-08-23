"""Writing and loading weights, where "written" means read back and hashed.

A registry row saying `artifact_path=/models/x.pt` is not evidence that weights
exist. So `save()` writes, fsyncs, re-reads and hashes the file, and returns the
digest that goes into the registry; `load()` re-hashes before reading and
refuses on a mismatch. A promoted version whose file was replaced, truncated or
never written therefore fails loudly at load rather than serving whatever is
there now.

The file is also never unpickled: metadata travels as a JSON string beside the
tensors so `load()` can use `weights_only=True`. A digest match proves the bytes
are the ones evaluated, not that they are safe to execute, and a checkpoint
written in any other shape is refused rather than trusted.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from typing import Any

import torch

from . import models


class CheckpointError(RuntimeError):
    """The checkpoint is missing, unreadable, or not the one that was recorded."""


def digest_file(path: str) -> str:
    hasher = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(block)
    except OSError as exc:
        raise CheckpointError(f"reading {path}: {exc}") from exc
    return hasher.hexdigest()


@dataclass(frozen=True)
class StoredCheckpoint:
    path: str
    digest: str
    bytes_written: int


def save(
    model: torch.nn.Module,
    *,
    directory: str,
    filename: str,
    kind: str,
    hyperparameters: dict[str, Any],
    feature_spec: dict[str, Any],
    provenance: dict[str, Any],
) -> StoredCheckpoint:
    """Store weights plus everything needed to rebuild and interpret them.

    The feature spec travels with the weights: loading a checkpoint against a
    different feature order would produce confident nonsense, and `load_for_serving`
    compares the two.
    """
    if kind not in models.KINDS:
        # Weights nothing can rebuild are unservable, so refuse before the file
        # exists rather than leaving a registry row pointing at a dead artifact.
        raise CheckpointError(
            f"model kind {kind!r} cannot be rebuilt by this service (known: {', '.join(models.KINDS)})"
        )
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, filename)
    payload = {
        # JSON, not objects: `load()` reads with `weights_only=True`, so nothing in
        # this file can execute on the serving host.
        "meta_json": json.dumps(
            {
                "kind": kind,
                "hyperparameters": hyperparameters,
                "feature_spec": feature_spec,
                "provenance": provenance,
                "torch_version": torch.__version__,
            },
            sort_keys=True,
        ),
        "state_dict": model.state_dict(),
    }
    try:
        with open(path, "wb") as handle:
            torch.save(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise CheckpointError(f"writing {path}: {exc}") from exc

    size = os.path.getsize(path)
    if size <= 0:
        raise CheckpointError(f"{path} is empty after writing")
    return StoredCheckpoint(path=path, digest=digest_file(path), bytes_written=size)


def load(path: str, expected_digest: str) -> dict[str, Any]:
    """Load a checkpoint, refusing anything whose bytes are not what was recorded."""
    if not os.path.exists(path):
        raise CheckpointError(f"{path} does not exist; the registered artifact is gone")
    actual = digest_file(path)
    if actual != expected_digest:
        raise CheckpointError(
            f"{path} digests to {actual} but the registry recorded {expected_digest}; "
            "these are not the weights that were evaluated"
        )
    try:
        raw = torch.load(path, map_location="cpu", weights_only=True)
    except Exception as exc:
        # Anything the safe loader refuses — arbitrary pickled objects, a torchscript
        # archive, a corrupt zip — is a refusal, not something to retry unsafely.
        raise CheckpointError(f"{path} could not be read as weights only: {exc}") from exc
    if not isinstance(raw, dict) or "meta_json" not in raw or "state_dict" not in raw:
        raise CheckpointError(
            f"{path} is not a checkpoint this service wrote (no meta_json/state_dict); "
            "it will not be unpickled, so the model must be retrained"
        )
    try:
        meta = json.loads(raw["meta_json"])
    except (TypeError, ValueError) as exc:
        raise CheckpointError(f"{path} carries unreadable metadata: {exc}") from exc
    if not isinstance(meta, dict):
        raise CheckpointError(f"{path} carries metadata that is not an object")
    return {**meta, "state_dict": raw["state_dict"]}


def load_for_serving(
    path: str, expected_digest: str, *, feature_spec_digest: str
) -> tuple[torch.nn.Module, dict[str, Any]]:
    """Rebuild a model ready for inference, with the feature contract checked."""
    payload = load(path, expected_digest)
    stored_spec = payload.get("feature_spec") or {}
    stored_digest = hashlib.sha256(
        json.dumps(stored_spec, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    if stored_digest != feature_spec_digest:
        raise CheckpointError(
            f"{path} was trained on feature spec {stored_digest} but the caller is building "
            f"features as {feature_spec_digest}; the inputs would not mean what the weights expect"
        )
    model = models.build(payload["kind"], payload["hyperparameters"])
    model.load_state_dict(payload["state_dict"])
    model.eval()
    return model, payload
