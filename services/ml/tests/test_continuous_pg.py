"""Continuous training against live Postgres: claiming, refusing, promoting.

The queue semantics are the reason these run against a real database. `FOR UPDATE
SKIP LOCKED` cannot be asserted without two concurrent transactions, and a job
executed twice would register two versions from one trigger.
"""

from __future__ import annotations

import pytest
import torch

from vppml import checkpoints, continuous, drift, features, registry
from vppml.drift import DriftReport, FeatureDrift, PerformanceCheck

from helpers import register

pytestmark = pytest.mark.usefixtures("connection")


def queue(connection, model_id, job_id="job-1", *, trigger="manual", config=None):
    return continuous.enqueue(
        connection,
        model_id=model_id,
        job_id=job_id,
        trigger_type=trigger,
        triggered_by="pytest",
        training_config=config or {"model_name": "asset_power_forecast", "origin": "platform"},
    )


def status_of(connection, job_id):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT status, started_at, completed_at, error_message, new_model_version "
            "FROM retraining_jobs WHERE job_id = %s",
            (job_id,),
        )
        return cursor.fetchone()


def test_a_queued_job_is_claimed_once_and_becomes_running(connection, tmp_path):
    model_id, _ = register(connection, tmp_path, version="v1", mae=180.0)
    queue(connection, model_id)

    claimed = continuous.claim(connection)
    assert claimed is not None
    assert claimed["job_id"] == "job-1"
    assert claimed["training_config"]["origin"] == "platform"
    status, started_at, _, _, _ = status_of(connection, "job-1")
    assert status == "running" and started_at is not None

    assert continuous.claim(connection) is None


def test_the_same_job_id_cannot_be_queued_twice(connection, tmp_path):
    model_id, _ = register(connection, tmp_path, version="v1", mae=180.0)
    assert queue(connection, model_id, "job-dup") == "job-dup"
    assert queue(connection, model_id, "job-dup") == ""
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM retraining_jobs WHERE job_id = 'job-dup'")
        assert cursor.fetchone()[0] == 1


def test_two_workers_never_claim_the_same_job(connection, dsn, tmp_path):
    """One trigger, two workers, one execution: without SKIP LOCKED the second worker
    would block and then claim the row the first had already taken."""
    import psycopg2

    model_id, _ = register(connection, tmp_path, version="v1", mae=180.0)
    queue(connection, model_id, "job-a")
    queue(connection, model_id, "job-b")

    other = psycopg2.connect(dsn)
    try:
        first = continuous.claim(connection)
        second = continuous.claim(other)
    finally:
        other.close()

    assert first is not None and second is not None
    assert {first["job_id"], second["job_id"]} == {"job-a", "job-b"}


def test_a_job_that_cannot_be_trained_is_cancelled_with_the_reason_not_completed(
    connection, config, tmp_path
):
    """The platform tables are empty here, so there is nothing to train on. The
    dangerous outcome would be a `completed` job and a registered version."""
    model_id, _ = register(connection, tmp_path, version="v1", mae=180.0)
    queue(connection, model_id, "job-empty")
    job = continuous.claim(connection)
    assert job is not None

    result = continuous.execute(connection, config, job)

    assert result.status == "refused"
    status, _, completed_at, error, version = status_of(connection, "job-empty")
    assert status == "cancelled"
    assert completed_at is not None and version is None
    assert "Nothing was trained" in error
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM model_registry WHERE model_version = 'v2'")
        assert cursor.fetchone()[0] == 0


def test_an_unreachable_ray_cluster_fails_the_job_instead_of_training_locally(
    connection, config, tmp_path, monkeypatch
):
    from dataclasses import replace

    monkeypatch.setattr("vppml.distributed.CONNECT_TIMEOUT_SECONDS", 2.0)
    model_id, _ = register(connection, tmp_path, version="v1", mae=180.0)
    queue(connection, model_id, "job-ray")
    job = continuous.claim(connection)
    assert job is not None
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM training_runs")
        runs_before = cursor.fetchone()[0]

    result = continuous.execute(
        connection, replace(config, ray_address="10.255.255.1:6399"), job
    )

    assert result.status == "failed"
    status, _, _, error, _ = status_of(connection, "job-ray")
    assert status == "failed"
    assert "not silently downgraded to local" in error
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM training_runs")
        assert cursor.fetchone()[0] == runs_before
        cursor.execute("SELECT count(*) FROM model_registry WHERE model_version = 'v2'")
        assert cursor.fetchone()[0] == 0


def test_the_first_version_is_promoted_when_nothing_is_live(connection, tmp_path):
    register(connection, tmp_path, version="v1", mae=180.0)
    promoted, note = continuous.maybe_promote(
        connection,
        model_name="asset_power_forecast",
        version="v1",
        metrics={"val_mae_w": 180.0},
    )
    assert promoted and "no production version existed" in note
    live = registry.production_version(connection, "asset_power_forecast")
    assert live is not None and live.model_version == "v1"


def test_a_candidate_that_does_not_beat_the_live_model_stays_staged(connection, tmp_path):
    register(connection, tmp_path, version="v1", mae=180.0)
    register(connection, tmp_path, version="v2", mae=179.0)
    registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")

    promoted, note = continuous.maybe_promote(
        connection,
        model_name="asset_power_forecast",
        version="v2",
        metrics={"val_mae_w": 179.0},
    )

    assert not promoted and "does not beat" in note
    assert registry.get_version(connection, "asset_power_forecast", "v2").status == "staging"
    live = registry.production_version(connection, "asset_power_forecast")
    assert live is not None and live.model_version == "v1"


def test_a_candidate_that_beats_the_live_model_by_the_margin_is_promoted(connection, tmp_path):
    register(connection, tmp_path, version="v1", mae=180.0)
    register(connection, tmp_path, version="v2", mae=120.0)
    registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")

    promoted, _ = continuous.maybe_promote(
        connection,
        model_name="asset_power_forecast",
        version="v2",
        metrics={"val_mae_w": 120.0},
    )

    assert promoted
    live = registry.production_version(connection, "asset_power_forecast")
    assert live is not None and live.model_version == "v2"


def test_a_candidate_with_no_held_out_mae_is_never_promoted(connection, tmp_path):
    register(connection, tmp_path, version="v1", mae=180.0)
    promoted, note = continuous.maybe_promote(
        connection, model_name="asset_power_forecast", version="v1", metrics={}
    )
    assert not promoted and "no held-out MAE" in note
    assert registry.production_version(connection, "asset_power_forecast") is None


def test_a_candidate_whose_artifact_vanished_is_not_promoted(connection, tmp_path):
    import os

    _, stored = register(connection, tmp_path, version="v1", mae=180.0)
    os.remove(stored.path)
    promoted, note = continuous.maybe_promote(
        connection,
        model_name="asset_power_forecast",
        version="v1",
        metrics={"val_mae_w": 180.0},
    )
    assert not promoted and note.startswith("not promoted")
    assert registry.production_version(connection, "asset_power_forecast") is None


def feature_drift(severity, *, psi=0.4, shift=2.0):
    return FeatureDrift(
        feature="power_norm",
        psi=psi,
        mean_shift=shift,
        baseline_mean=0.1,
        current_mean=0.6,
        severity=severity,
        samples=900,
    )


def test_retraining_is_triggered_by_measured_drift_and_measured_degradation():
    severe = DriftReport(state="measured", features=[feature_drift("severe")], samples=900)
    assert continuous.should_retrain(severe, PerformanceCheck(state="no_actuals")) is not None

    degraded = PerformanceCheck(
        state="measured",
        predictions=400,
        mae=400.0,
        baseline_mae=100.0,
        ratio=4.0,
        degraded=True,
        detail="live MAE 400 W is 4.0x the validation MAE",
    )
    clean = DriftReport(state="measured", features=[feature_drift("none", psi=0.01, shift=0.1)])
    assert "performance_threshold" in continuous.should_retrain(clean, degraded)


def test_unmeasurable_drift_never_triggers_a_retrain():
    """Telemetry going quiet is the worst possible moment to replace the model, and
    a missing baseline is not evidence of drift."""
    for state in ("no_baseline", "insufficient_data"):
        assert (
            continuous.should_retrain(
                DriftReport(state=state, detail="x"), PerformanceCheck(state="no_actuals")
            )
            is None
        )
    moderate = DriftReport(
        state="measured", features=[feature_drift("moderate", psi=0.15, shift=0.7)]
    )
    assert continuous.should_retrain(moderate, PerformanceCheck(state="no_actuals")) is None


def test_a_tick_with_no_baseline_queues_nothing(connection, config, tmp_path):
    """A production model whose drift cannot be measured must not be retrained on a
    schedule; the tick has to be a no-op rather than a queued job."""
    register(connection, tmp_path, version="v1", mae=180.0)
    registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM model_feature_baselines")
    connection.commit()

    results = continuous.tick(connection, config)

    assert results == []
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM retraining_jobs")
        assert cursor.fetchone()[0] == 0


def test_measured_live_degradation_is_read_from_predictions_with_actuals(connection, tmp_path):
    model_id, _ = register(connection, tmp_path, version="v1", mae=100.0)
    with connection.cursor() as cursor:
        for index in range(60):
            cursor.execute(
                """
                INSERT INTO model_predictions (model_id, input_hash, predicted_value, actual_value)
                VALUES (%s, %s, %s, %s)
                """,
                (model_id, f"{index:064d}", 1000.0, 1400.0),
            )
        # Predictions with no actual yet must not count towards accuracy either way.
        for index in range(20):
            cursor.execute(
                """
                INSERT INTO model_predictions (model_id, input_hash, predicted_value)
                VALUES (%s, %s, %s)
                """,
                (model_id, f"{index + 100:064d}", 9999.0),
            )
    connection.commit()

    check = drift.performance_since_deploy(connection, model_id, baseline_mae=100.0)

    assert check.state == "measured"
    assert check.degraded
    assert check.predictions == 60
    assert check.mae == pytest.approx(400.0)
    assert check.ratio == pytest.approx(4.0)


def test_a_job_over_real_platform_rows_registers_a_verifiable_version(connection, config, tmp_path):
    """The whole path with nothing stubbed: telemetry in the platform tables, a queued
    job, a trained checkpoint on disk, and a registry row whose digest still matches
    the bytes. A registry row alone is not evidence a model exists, so the artifact is
    re-read here the way promotion re-reads it."""
    import hashlib
    import os

    from helpers import seed_platform_telemetry

    model_id, _ = register(connection, tmp_path, version="v1", mae=180.0)
    _, rows = seed_platform_telemetry(connection)
    assert rows > 0
    queue(
        connection,
        model_id,
        "job-real",
        config={"model_name": "asset_power_forecast", "origin": "platform"},
    )
    job = continuous.claim(connection)
    assert job is not None

    result = continuous.execute(connection, config, job)

    assert result.status == "completed", result.detail
    status, _, completed_at, error, version = status_of(connection, "job-real")
    assert (status, error) == ("completed", None)
    assert completed_at is not None and version == result.version

    registered = registry.get_version(connection, "asset_power_forecast", result.version)
    assert registered is not None
    assert registered.status == "production"  # nothing was live, and the artifact verified
    assert registered.validation_metrics["val_mae_w"] > 0

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT r.state, r.epochs_ran, r.checkpoint_path, r.checkpoint_digest,
                   d.origin, d.rows, d.sequences, d.generator, d.seed
              FROM training_runs r JOIN training_datasets d ON d.id = r.dataset_id
             WHERE r.model_id = %s
            """,
            (registered.id,),
        )
        state, epochs, path, digest, origin, dataset_rows, sequences, generator, seed = (
            cursor.fetchone()
        )

    assert state == "succeeded" and epochs >= 1
    assert (origin, generator, seed) == ("platform", None, None)
    # The trainer's window opens a moment after seeding, so it reads all but the
    # oldest step of each asset's series; it must never read more than was written.
    assert 0 < dataset_rows <= rows and sequences > 0
    assert os.path.exists(path)
    with open(path, "rb") as handle:
        assert hashlib.sha256(handle.read()).hexdigest() == digest

    # And the weights rebuild into a module that will accept the features this
    # platform builds — a checkpoint that cannot be served is not a trained model.
    from helpers import SPEC

    model, payload = checkpoints.load_for_serving(
        path, digest, feature_spec_digest=SPEC.digest()
    )
    assert payload["kind"] == "asset_forecaster"
    with torch.no_grad():
        prediction = model(torch.zeros(1, SPEC.lookback, len(features.FEATURE_NAMES)))
    assert prediction.shape == (1, SPEC.horizon)
