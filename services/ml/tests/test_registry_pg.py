"""The registry against live Postgres: what a `production` row is allowed to mean."""

from __future__ import annotations

import os

import pytest
import torch

from vppml import features, models, registry
from vppml.registry import RegistryError

from helpers import SPEC, make_dataset, register

pytestmark = pytest.mark.usefixtures("connection")


def test_a_registered_version_lands_staged_with_its_run_and_baselines(connection, tmp_path):
    model_id, _ = register(connection, tmp_path, version="v1", mae=180.0)
    version = registry.get_version(connection, "asset_power_forecast", "v1")
    assert version is not None
    assert version.status == "staging"
    assert version.training_run_id is not None
    assert version.validation_metrics["val_mae_w"] == 180.0
    assert registry.production_version(connection, "asset_power_forecast") is None
    assert set(registry.feature_baselines(connection, model_id)) == set(features.FEATURE_NAMES)


def test_a_lakehouse_dataset_must_carry_a_digest_for_every_object(connection):
    """Postgres refuses the row, so an unverifiable lake provenance cannot be written
    even if a caller forgets to pass the digests."""
    with pytest.raises(Exception, match="training_datasets_lake_has_objects"):
        make_dataset(
            connection,
            origin="lakehouse",
            source_objects=["raw/telemetry/a.parquet"],
            source_digests=[],
            generator=None,
            generator_version=None,
            seed=None,
        )
    connection.rollback()


def test_a_synthetic_dataset_must_carry_its_seed(connection):
    with pytest.raises(Exception, match="training_datasets_synthetic_is_reproducible"):
        make_dataset(connection, seed=None)
    connection.rollback()


def test_promotion_verifies_the_artifact_and_leaves_one_production_version(connection, tmp_path):
    register(connection, tmp_path, version="v1", mae=180.0)
    register(connection, tmp_path, version="v2", mae=150.0)

    registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")
    registry.promote(connection, "asset_power_forecast", "v2", actor="pytest")

    live = registry.production_version(connection, "asset_power_forecast")
    assert live is not None and live.model_version == "v2"
    assert registry.get_version(connection, "asset_power_forecast", "v1").status == "deprecated"
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM model_registry WHERE model_name = %s AND status = 'production'",
            ("asset_power_forecast",),
        )
        assert cursor.fetchone()[0] == 1


def test_a_version_whose_weights_were_deleted_cannot_be_promoted(connection, tmp_path):
    _, stored = register(connection, tmp_path, version="v1", mae=180.0)
    os.remove(stored.path)
    with pytest.raises(RegistryError, match="No such file|artifact directory may not"):
        registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")
    assert registry.production_version(connection, "asset_power_forecast") is None


def test_a_version_whose_weights_changed_cannot_be_promoted(connection, tmp_path):
    _, stored = register(connection, tmp_path, version="v1", mae=180.0)
    with open(stored.path, "r+b") as handle:
        handle.seek(64)
        handle.write(b"\x00\x01\x02\x03")
    with pytest.raises(RegistryError, match="digests to"):
        registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")
    assert registry.production_version(connection, "asset_power_forecast") is None


def test_repromoting_the_production_version_still_verifies_its_weights(connection, tmp_path):
    """Re-promoting is idempotent, but only if the weights are still the recorded ones:
    reporting success here would be an all-clear for an artifact nothing can serve."""
    _, stored = register(connection, tmp_path, version="v1", mae=180.0)
    registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")
    with open(stored.path, "r+b") as handle:
        handle.seek(64)
        handle.write(b"\x00\x01\x02\x03")
    with pytest.raises(RegistryError, match="digests to"):
        registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")


def test_rollback_returns_the_named_version_and_records_where_it_came_from(connection, tmp_path):
    register(connection, tmp_path, version="v1", mae=180.0)
    register(connection, tmp_path, version="v2", mae=150.0)
    registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")
    promoted = registry.promote(connection, "asset_power_forecast", "v2", actor="pytest")

    restored = registry.rollback(connection, "asset_power_forecast", "v1", actor="pytest")
    assert restored.status == "production"
    assert registry.get_version(connection, "asset_power_forecast", "v2").status == "deprecated"
    with connection.cursor() as cursor:
        cursor.execute("SELECT rolled_back_from_id FROM model_registry WHERE id = %s", (restored.id,))
        assert cursor.fetchone()[0] == promoted.id


def test_a_rollback_to_missing_weights_leaves_the_fleet_on_the_model_it_had(connection, tmp_path):
    """The dangerous shape: a rollback that stands the live version down and then
    fails to install the target, leaving no production model at all."""
    _, first = register(connection, tmp_path, version="v1", mae=180.0)
    register(connection, tmp_path, version="v2", mae=150.0)
    registry.promote(connection, "asset_power_forecast", "v1", actor="pytest")
    registry.promote(connection, "asset_power_forecast", "v2", actor="pytest")
    os.remove(first.path)

    with pytest.raises(RegistryError):
        registry.rollback(connection, "asset_power_forecast", "v1", actor="pytest")

    live = registry.production_version(connection, "asset_power_forecast")
    assert live is not None and live.model_version == "v2"


def test_a_version_that_was_never_trained_here_cannot_be_promoted(connection, tmp_path):
    """Rows written by anything other than a verified training run — the pre-existing
    registry had no artifact requirement at all."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO model_registry (model_name, model_version, model_type, status)
            VALUES ('asset_power_forecast', 'v9', 'load_forecast', 'staging')
            """
        )
    connection.commit()
    with pytest.raises(RegistryError, match="has no recorded artifact"):
        registry.promote(connection, "asset_power_forecast", "v9", actor="pytest")


def test_the_next_version_follows_the_highest_registered_one(connection, tmp_path):
    assert registry.next_version(connection, "asset_power_forecast") == "v1"
    register(connection, tmp_path, version="v1", mae=180.0)
    assert registry.next_version(connection, "asset_power_forecast") == "v2"


def test_a_refused_run_carries_no_model_and_no_checkpoint(connection):
    dataset_id = make_dataset(connection)
    run_id = registry.start_run(
        connection,
        dataset_id=dataset_id,
        model_name="asset_power_forecast",
        model_kind=models.AssetForecaster.kind,
        framework="pytorch",
        framework_version=torch.__version__,
        compute="local",
        hyperparameters={},
        epochs_requested=2,
        runner="pytest",
        trigger="manual",
    )
    registry.refuse_run(connection, run_id, "12 sequence(s) is below the minimum")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT state, refusal_reason, model_id, checkpoint_path FROM training_runs WHERE id = %s",
            (run_id,),
        )
        state, reason, model_id, checkpoint = cursor.fetchone()
    assert (state, model_id, checkpoint) == ("refused", None, None)
    assert "below the minimum" in reason
