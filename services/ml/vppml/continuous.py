"""Continuous training: retrain when the data says so, and promote only on evidence.

`retraining_jobs` already existed and was queued by the TypeScript MLOps service —
but nothing ever executed a job, so a queued row sat at `queued` forever while the
UI reported retraining as under way. This module is the executor, and it is
deliberately conservative about the two decisions that matter.

**When to retrain.** Only on measured drift or measured live degradation against a
stored baseline, or an explicit manual request. `no_baseline` and
`insufficient_data` do *not* trigger a retrain: retraining because drift could not
be measured would mean a model is replaced whenever telemetry goes quiet, which is
the worst moment to change it.

**Whether to promote.** A finished run leaves its version in `staging`. Promotion
happens only when the new version's held-out MAE is at least `IMPROVEMENT_MARGIN`
better than the live version's, both figures come from the same feature spec, and
the new artifact re-hashes to what the run recorded. Otherwise the version stays
staged with the comparison recorded — a retrain that came out worse must not
become production just because it is newer.

Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so two workers cannot execute the
same job and double-register a version.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional

from . import drift, features, registry, train
from .config import Config
from .distributed import RayUnavailable, compute
from .registry import RegistryError

logger = logging.getLogger(__name__)

#: A replacement has to be at least this much better on held-out MAE to be promoted.
IMPROVEMENT_MARGIN = 0.02


@dataclass
class JobResult:
    job_id: str
    #: 'completed' | 'failed' | 'cancelled' | 'refused'
    status: str
    version: Optional[str] = None
    promoted: bool = False
    detail: str = ""


def enqueue(
    connection: Any,
    *,
    model_id: int,
    job_id: str,
    trigger_type: str,
    triggered_by: str,
    training_config: dict[str, Any],
) -> str:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO retraining_jobs
              (model_id, job_id, trigger_type, triggered_by, status, training_config)
            VALUES (%s, %s, %s, %s, 'queued', %s)
            ON CONFLICT (job_id) DO NOTHING
            RETURNING job_id
            """,
            (
                model_id,
                job_id,
                trigger_type,
                triggered_by,
                json.dumps(training_config, sort_keys=True, default=str),
            ),
        )
        row = cursor.fetchone()
    connection.commit()
    return job_id if row else ""


def claim(connection: Any) -> Optional[dict[str, Any]]:
    """Take the oldest queued job, or None. Claimed rows are `running` on commit."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, job_id, model_id, trigger_type, triggered_by, training_config
              FROM retraining_jobs
             WHERE status = 'queued'
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
            """
        )
        row = cursor.fetchone()
        if row is None:
            connection.rollback()
            return None
        cursor.execute(
            "UPDATE retraining_jobs SET status = 'running', started_at = now() WHERE id = %s",
            (row[0],),
        )
    connection.commit()
    config: dict[str, Any] = {}
    if row[5]:
        try:
            config = json.loads(row[5])
        except (TypeError, ValueError):
            config = {}
    return {
        "id": int(row[0]),
        "job_id": row[1],
        "model_id": int(row[2]),
        "trigger_type": row[3],
        "triggered_by": row[4],
        "training_config": config,
    }


def _close_job(
    connection: Any,
    job_id: str,
    status: str,
    *,
    version: Optional[str] = None,
    metrics: Optional[dict[str, Any]] = None,
    error: Optional[str] = None,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE retraining_jobs
               SET status = %s, completed_at = now(), new_model_version = %s,
                   metrics = %s, error_message = %s
             WHERE job_id = %s
            """,
            (
                status,
                version,
                json.dumps(metrics, sort_keys=True, default=str) if metrics else None,
                error[:2000] if error else None,
                job_id,
            ),
        )
    connection.commit()


def evaluate_drift(
    connection: Any,
    config: Config,
    *,
    model_id: int,
    model_name: str,
    window_hours: int = 24 * 3,
    origin: str = "platform",
) -> tuple[drift.DriftReport, drift.PerformanceCheck]:
    """Measure the live window against the model's stored training baseline."""
    baselines = registry.feature_baselines(connection, model_id)
    window_start, window_end = train.default_window(window_hours)
    from . import data as data_module

    spec = features.FeatureSpec(lookback=24, horizon=4, interval_minutes=15)
    try:
        source = data_module.resolve(
            connection,
            config,
            origin,
            window_start=window_start,
            window_end=window_end,
        )
        sequences = features.build_sequences(
            source.columns,
            spec,
            asset_kinds=source.asset_kinds,
            asset_capacities=source.asset_capacities,
        )
        report = drift.compare(baselines, sequences.x, features.FEATURE_NAMES)
    except data_module.DataError as exc:
        report = drift.DriftReport(state="insufficient_data", detail=str(exc))

    version = registry.production_version(connection, model_name)
    baseline_mae = None
    if version is not None:
        raw = version.validation_metrics.get("val_mae_w")
        baseline_mae = float(raw) if isinstance(raw, (int, float)) else None
    performance = drift.performance_since_deploy(
        connection, model_id, baseline_mae=baseline_mae
    )
    return report, performance


def should_retrain(report: drift.DriftReport, performance: drift.PerformanceCheck) -> Optional[str]:
    """The trigger to record, or None. Unmeasured is never a trigger."""
    if report.state == "measured" and report.severity == "severe":
        drifted = ", ".join(item.feature for item in report.drifted if item.severity == "severe")
        return f"drift_detected: {drifted}"
    if performance.state == "measured" and performance.degraded:
        return f"performance_threshold: {performance.detail}"
    return None


def execute(
    connection: Any,
    config: Config,
    job: dict[str, Any],
    *,
    window_hours: int = 24 * 14,
) -> JobResult:
    """Run one claimed job to completion, or record why it did not run."""
    job_id = job["job_id"]
    settings = job["training_config"] or {}
    origin = settings.get("origin", "platform")
    model_name = settings.get("model_name") or "asset_power_forecast"
    window_start, window_end = train.default_window(int(settings.get("window_hours", window_hours)))

    try:
        with compute(config.ray_address) as context:
            outcome = train.train_forecaster(
                connection,
                config,
                train.TrainingConfig(model_name=model_name),
                origin=origin,
                window_start=window_start,
                window_end=window_end,
                seed=settings.get("seed"),
                trigger=job["trigger_type"],
                retraining_job_id=job_id,
                compute=context.label,
            )
    except RayUnavailable as exc:
        _close_job(connection, job_id, "failed", error=str(exc))
        return JobResult(job_id=job_id, status="failed", detail=str(exc))

    if outcome.state == "refused":
        # `cancelled` rather than `failed`: nothing broke, there was not enough
        # verifiable data to train on, and the reason is on the row.
        _close_job(connection, job_id, "cancelled", error=outcome.refusal_reason)
        return JobResult(job_id=job_id, status="refused", detail=outcome.detail)
    if outcome.state == "failed":
        _close_job(connection, job_id, "failed", error=outcome.error)
        return JobResult(job_id=job_id, status="failed", detail=outcome.detail)

    assert outcome.version is not None
    promoted, note = maybe_promote(
        connection, model_name=model_name, version=outcome.version, metrics=outcome.metrics or {}
    )
    _close_job(
        connection,
        job_id,
        "completed",
        version=outcome.version,
        metrics={**(outcome.metrics or {}), "promoted": promoted, "promotion_note": note},
    )
    return JobResult(
        job_id=job_id,
        status="completed",
        version=outcome.version,
        promoted=promoted,
        detail=f"{outcome.detail}. {note}",
    )


def maybe_promote(
    connection: Any, *, model_name: str, version: str, metrics: dict[str, float]
) -> tuple[bool, str]:
    """Promote the new version only if it measurably beats the live one."""
    candidate_mae = metrics.get("val_mae_w")
    if candidate_mae is None:
        return False, "no held-out MAE recorded, so the version stays staged"

    live = registry.production_version(connection, model_name)
    if live is None:
        try:
            registry.promote(connection, model_name, version, actor="continuous-training")
        except RegistryError as exc:
            return False, f"not promoted: {exc}"
        return True, "promoted: no production version existed and this one's artifact verified"

    live_mae = live.validation_metrics.get("val_mae_w")
    if not isinstance(live_mae, (int, float)) or live_mae <= 0:
        return (
            False,
            f"the live version {live.model_version} records no comparable held-out MAE, so this "
            "version stays staged rather than replacing it on a number that cannot be compared",
        )

    if candidate_mae > float(live_mae) * (1.0 - IMPROVEMENT_MARGIN):
        return (
            False,
            f"staged: {candidate_mae:.1f} W held-out MAE does not beat {live.model_version}'s "
            f"{float(live_mae):.1f} W by the {IMPROVEMENT_MARGIN:.0%} margin",
        )

    try:
        registry.promote(connection, model_name, version, actor="continuous-training")
    except RegistryError as exc:
        return False, f"not promoted: {exc}"
    return (
        True,
        f"promoted: {candidate_mae:.1f} W held-out MAE beats {live.model_version}'s "
        f"{float(live_mae):.1f} W",
    )


def tick(connection: Any, config: Config) -> list[JobResult]:
    """One pass: evaluate drift for each production model, queue what needs it, then
    execute whatever is claimable. Safe to run on a schedule."""
    results: list[JobResult] = []
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, model_name FROM model_registry WHERE status = 'production' ORDER BY id"
        )
        live = [(int(row[0]), row[1]) for row in cursor.fetchall()]

    for model_id, model_name in live:
        report, performance = evaluate_drift(
            connection, config, model_id=model_id, model_name=model_name
        )
        trigger = should_retrain(report, performance)
        if trigger is None:
            logger.info(
                "%s: no retrain (drift %s, performance %s)",
                model_name,
                report.state if report.state != "measured" else report.severity,
                performance.state,
            )
            continue
        job_id = f"retrain-{model_name}-{int(datetime.utcnow().timestamp())}"
        enqueue(
            connection,
            model_id=model_id,
            job_id=job_id,
            trigger_type="drift_detected" if trigger.startswith("drift") else "performance_threshold",
            triggered_by="continuous-training",
            training_config={"model_name": model_name, "origin": "platform", "reason": trigger},
        )

    while True:
        job = claim(connection)
        if job is None:
            break
        results.append(execute(connection, config, job))
    return results
