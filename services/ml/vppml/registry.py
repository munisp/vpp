"""The registry: datasets, runs, versions, and which version is live.

Promotion and rollback are the two operations that can hurt. Both are written so
that a version can only become `production` when its weights are on disk *and*
digest to what the training run recorded:

    promote(...) -> reads the row, re-hashes the artifact, then in one transaction
                    deprecates the current production version and installs the new
                    one. A partial unique index enforces one production version per
                    model name, so two concurrent promotions cannot both win.

    rollback(...) -> the same verification, against the *older* version being
                     returned to. A rollback whose target artifact is gone is
                     refused; it does not fall through to "no production model" and
                     it does not leave the failing version live.

Nothing here repairs anything on its own. A refusal is returned to the caller and
recorded, because a registry that quietly picks a different model than the one
asked for is the failure mode this whole layer exists to prevent.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional, Sequence

from .checkpoints import CheckpointError, digest_file


class RegistryError(RuntimeError):
    """The registry refuses: the row, the artifact or the state does not permit it."""


@dataclass(frozen=True)
class ModelVersion:
    id: int
    model_name: str
    model_version: str
    model_type: str
    status: str
    framework: Optional[str]
    artifact_path: Optional[str]
    artifact_hash: Optional[str]
    training_dataset_id: Optional[int]
    training_run_id: Optional[int]
    validation_metrics: dict[str, Any]
    deployed_at: Optional[datetime]


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def insert_dataset(
    connection: Any,
    *,
    name: str,
    origin: str,
    task: str,
    feature_spec: dict[str, Any],
    feature_spec_digest: str,
    window_start: datetime,
    window_end: datetime,
    rows: int,
    sequences: int,
    entities: int,
    source_objects: Sequence[str] = (),
    source_digests: Sequence[str] = (),
    generator: Optional[str] = None,
    generator_version: Optional[str] = None,
    seed: Optional[int] = None,
    created_by: str,
) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO training_datasets
              (name, origin, task, feature_spec, feature_spec_digest, window_start, window_end,
               rows, sequences, entities, source_objects, source_digests,
               generator, generator_version, seed, created_by)
            VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                name,
                origin,
                task,
                _json(feature_spec),
                feature_spec_digest,
                window_start,
                window_end,
                rows,
                sequences,
                entities,
                list(source_objects),
                list(source_digests),
                generator,
                generator_version,
                seed,
                created_by,
            ),
        )
        dataset_id = int(cursor.fetchone()[0])
    connection.commit()
    return dataset_id


def start_run(
    connection: Any,
    *,
    dataset_id: int,
    model_name: str,
    model_kind: str,
    framework: str,
    framework_version: str,
    compute: str,
    hyperparameters: dict[str, Any],
    epochs_requested: int,
    runner: str,
    trigger: str,
    retraining_job_id: Optional[str] = None,
) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO training_runs
              (dataset_id, model_name, model_kind, state, framework, framework_version, compute,
               hyperparameters, epochs_requested, runner, trigger, retraining_job_id)
            VALUES (%s, %s, %s, 'running', %s, %s, %s, %s::jsonb, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                dataset_id,
                model_name,
                model_kind,
                framework,
                framework_version,
                compute,
                _json(hyperparameters),
                epochs_requested,
                runner,
                trigger,
                retraining_job_id,
            ),
        )
        run_id = int(cursor.fetchone()[0])
    connection.commit()
    return run_id


def refuse_run(connection: Any, run_id: int, reason: str) -> None:
    """A run that declined to train. It carries no checkpoint and no model id, so
    it can never be read as a model that exists."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE training_runs
               SET state = 'refused', refusal_reason = %s, finished_at = now(),
                   duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::int)
             WHERE id = %s
            """,
            (reason[:600], run_id),
        )
    connection.commit()


def fail_run(connection: Any, run_id: int, error: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE training_runs
               SET state = 'failed', error = %s, finished_at = now(),
                   duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::int)
             WHERE id = %s
            """,
            (error[:2000], run_id),
        )
    connection.commit()


def complete_run(
    connection: Any,
    *,
    run_id: int,
    dataset_id: int,
    model_name: str,
    model_kind: str,
    model_type: str,
    version: str,
    framework: str,
    checkpoint_path: str,
    checkpoint_digest: str,
    checkpoint_bytes: int,
    hyperparameters: dict[str, Any],
    feature_spec: dict[str, Any],
    metrics: dict[str, float],
    epochs_ran: int,
    best_epoch: int,
    train_loss: float,
    val_loss: float,
    train_sequences: int,
    val_sequences: int,
    split_at: Optional[datetime],
    training_data_start: datetime,
    training_data_end: datetime,
    training_samples: int,
    feature_statistics: dict[str, dict[str, Any]],
) -> int:
    """Register the version and close the run, in one transaction.

    A model version and the run that produced it either both exist or neither
    does: a registry row with no run behind it is exactly the unprovenanced shape
    this table set out to remove. New versions land in `staging` — promotion is a
    separate, deliberate act.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO model_registry
              (model_name, model_version, model_type, artifact_path, artifact_hash,
               training_data_start, training_data_end, training_duration_seconds, framework,
               input_schema, output_schema, hyperparameters, training_samples,
               validation_metrics, status, metadata, training_dataset_id, training_run_id)
            SELECT %s, %s, %s, %s, %s, %s, %s,
                   GREATEST(0, EXTRACT(EPOCH FROM (now() - r.started_at))::int), %s,
                   %s, %s, %s::text, %s, %s, 'staging', %s, %s, %s
              FROM training_runs r WHERE r.id = %s
            RETURNING id
            """,
            (
                model_name,
                version,
                model_type,
                checkpoint_path,
                checkpoint_digest,
                training_data_start,
                training_data_end,
                framework,
                _json(feature_spec),
                _json({"horizon": feature_spec.get("horizon"), "unit": "normalised_power"}),
                _json(hyperparameters),
                training_samples,
                _json(metrics),
                _json({"model_kind": model_kind}),
                dataset_id,
                run_id,
                run_id,
            ),
        )
        row = cursor.fetchone()
        if row is None:
            raise RegistryError(f"training run {run_id} disappeared before its model was registered")
        model_id = int(row[0])

        cursor.execute(
            """
            UPDATE training_runs
               SET state = 'succeeded', model_id = %s, epochs_ran = %s, best_epoch = %s,
                   train_loss = %s, val_loss = %s, metrics = %s::jsonb,
                   checkpoint_path = %s, checkpoint_digest = %s, checkpoint_bytes = %s,
                   train_sequences = %s, val_sequences = %s, split_at = %s,
                   finished_at = now(),
                   duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::int)
             WHERE id = %s
            """,
            (
                model_id,
                epochs_ran,
                best_epoch,
                train_loss,
                val_loss,
                _json(metrics),
                checkpoint_path,
                checkpoint_digest,
                checkpoint_bytes,
                train_sequences,
                val_sequences,
                split_at,
                run_id,
            ),
        )

        for feature, stats in feature_statistics.items():
            cursor.execute(
                """
                INSERT INTO model_feature_baselines
                  (model_id, dataset_id, feature, mean, std, p05, p50, p95,
                   bin_edges, bin_shares, sample_count)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (model_id, feature) DO UPDATE
                   SET mean = EXCLUDED.mean, std = EXCLUDED.std, p05 = EXCLUDED.p05,
                       p50 = EXCLUDED.p50, p95 = EXCLUDED.p95,
                       bin_edges = EXCLUDED.bin_edges, bin_shares = EXCLUDED.bin_shares,
                       sample_count = EXCLUDED.sample_count, computed_at = now()
                """,
                (
                    model_id,
                    dataset_id,
                    feature,
                    stats["mean"],
                    stats["std"],
                    stats["p05"],
                    stats["p50"],
                    stats["p95"],
                    stats["bin_edges"],
                    stats["bin_shares"],
                    stats["sample_count"],
                ),
            )
    connection.commit()
    return model_id


def _row_to_version(row: Sequence[Any]) -> ModelVersion:
    metrics: dict[str, Any] = {}
    if row[10]:
        try:
            metrics = json.loads(row[10])
        except (TypeError, ValueError):
            metrics = {}
    return ModelVersion(
        id=int(row[0]),
        model_name=row[1],
        model_version=row[2],
        model_type=row[3],
        status=row[4],
        framework=row[5],
        artifact_path=row[6],
        artifact_hash=row[7],
        training_dataset_id=row[8],
        training_run_id=row[9],
        validation_metrics=metrics,
        deployed_at=row[11],
    )


_VERSION_COLUMNS = """
    id, model_name, model_version, model_type, status, framework, artifact_path, artifact_hash,
    training_dataset_id, training_run_id, validation_metrics, deployed_at
"""


def get_version(connection: Any, model_name: str, version: str) -> Optional[ModelVersion]:
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT {_VERSION_COLUMNS} FROM model_registry "
            "WHERE model_name = %s AND model_version = %s",
            (model_name, version),
        )
        row = cursor.fetchone()
    return _row_to_version(row) if row else None


def production_version(connection: Any, model_name: str) -> Optional[ModelVersion]:
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT {_VERSION_COLUMNS} FROM model_registry "
            "WHERE model_name = %s AND status = 'production'",
            (model_name,),
        )
        row = cursor.fetchone()
    return _row_to_version(row) if row else None


def verify_artifact(version: ModelVersion) -> None:
    """Refuse a version whose weights are absent or altered.

    This is the check that makes a `production` row mean something. Without it,
    promotion is a status column and inference would load whatever file currently
    sits at that path.
    """
    if not version.artifact_path or not version.artifact_hash:
        raise RegistryError(
            f"{version.model_name} {version.model_version} has no recorded artifact: "
            "it was never trained by this service and cannot be served"
        )
    try:
        actual = digest_file(version.artifact_path)
    except CheckpointError as exc:
        raise RegistryError(
            f"{version.model_name} {version.model_version}: {exc}. The artifact directory may not "
            "be mounted here; nothing is promoted on an unverifiable artifact."
        ) from exc
    if actual != version.artifact_hash:
        raise RegistryError(
            f"{version.model_name} {version.model_version}: {version.artifact_path} digests to "
            f"{actual} but the registry recorded {version.artifact_hash}"
        )


def promote(connection: Any, model_name: str, version: str, *, actor: str) -> ModelVersion:
    """Make a staged version the production version, after verifying its weights."""
    target = get_version(connection, model_name, version)
    if target is None:
        raise RegistryError(f"{model_name} {version} is not in the registry")
    if target.status in ("failed", "deprecated"):
        raise RegistryError(
            f"{model_name} {version} is {target.status}; promote a staged version or roll back to "
            "a previously deployed one instead"
        )
    # Verified before the already-production shortcut: a promote that reports success on
    # a version whose weights no longer hash to what was recorded would be an all-clear
    # for an artifact nothing can serve.
    verify_artifact(target)
    if target.status == "production":
        return target

    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE model_registry
               SET status = 'deprecated', deprecated_at = now(), updated_at = now()
             WHERE model_name = %s AND status = 'production'
            """,
            (model_name,),
        )
        cursor.execute(
            """
            UPDATE model_registry
               SET status = 'production', deployed_at = now(), updated_at = now(),
                   metadata = COALESCE(metadata, '{}'),
                   rolled_back_from_id = NULL
             WHERE id = %s
            """,
            (target.id,),
        )
    connection.commit()
    promoted = get_version(connection, model_name, version)
    assert promoted is not None
    return promoted


def rollback(connection: Any, model_name: str, to_version: str, *, actor: str) -> ModelVersion:
    """Return production to a named earlier version.

    The target's artifact is verified *before* the current version is stood down,
    so a rollback to a missing checkpoint leaves the fleet on the model it already
    had rather than on none at all.
    """
    target = get_version(connection, model_name, to_version)
    if target is None:
        raise RegistryError(f"{model_name} {to_version} is not in the registry")
    current = production_version(connection, model_name)
    if current is not None and current.id == target.id:
        raise RegistryError(f"{model_name} {to_version} is already the production version")
    verify_artifact(target)

    with connection.cursor() as cursor:
        if current is not None:
            cursor.execute(
                """
                UPDATE model_registry
                   SET status = 'deprecated', deprecated_at = now(), updated_at = now()
                 WHERE id = %s
                """,
                (current.id,),
            )
        cursor.execute(
            """
            UPDATE model_registry
               SET status = 'production', deployed_at = now(), updated_at = now(),
                   deprecated_at = NULL, rolled_back_from_id = %s
             WHERE id = %s
            """,
            (current.id if current else None, target.id),
        )
    connection.commit()
    restored = get_version(connection, model_name, to_version)
    assert restored is not None
    return restored


def next_version(connection: Any, model_name: str) -> str:
    """`v<n>` where n is one past the highest numbered version for this name."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT model_version FROM model_registry WHERE model_name = %s",
            (model_name,),
        )
        rows = [row[0] for row in cursor.fetchall()]
    highest = 0
    for value in rows:
        if isinstance(value, str) and value.startswith("v") and value[1:].isdigit():
            highest = max(highest, int(value[1:]))
    return f"v{highest + 1}"


def feature_baselines(connection: Any, model_id: int) -> dict[str, dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT feature, mean, std, p05, p50, p95, bin_edges, bin_shares, sample_count
              FROM model_feature_baselines WHERE model_id = %s
            """,
            (model_id,),
        )
        return {
            row[0]: {
                "mean": float(row[1]),
                "std": float(row[2]),
                "p05": float(row[3]),
                "p50": float(row[4]),
                "p95": float(row[5]),
                "bin_edges": [float(value) for value in row[6]],
                "bin_shares": [float(value) for value in row[7]],
                "sample_count": int(row[8]),
            }
            for row in cursor.fetchall()
        }
