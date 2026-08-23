"""Shared fixtures for the live-Postgres tests: a dataset, a run and a stored model.

Registration goes through `vppml.registry` rather than raw inserts, so a test that
promotes or rolls back is exercising the same path production uses, including the
artifact re-hash.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import torch

from vppml import checkpoints, features, models, registry, synthetic

START = datetime(2026, 1, 1)
END = START + timedelta(days=7)
SPEC = features.FeatureSpec(lookback=24, horizon=4, interval_minutes=15)


def make_dataset(connection, *, origin="synthetic", **overrides):
    kwargs = dict(
        name="asset_power_forecast:synthetic",
        origin=origin,
        task="asset_power_forecast",
        feature_spec=SPEC.as_dict(),
        feature_spec_digest=SPEC.digest(),
        window_start=START,
        window_end=END,
        rows=5000,
        sequences=900,
        entities=30,
        generator="vppml.synthetic.fleet",
        generator_version="1",
        seed=11,
        created_by="pytest",
    )
    kwargs.update(overrides)
    return registry.insert_dataset(connection, **kwargs)


def store_checkpoint(directory, filename="m.pt"):
    config = models.ForecasterConfig(
        features=len(features.FEATURE_NAMES), lookback=24, horizon=4, hidden=8, layers=1, dropout=0.0
    )
    return checkpoints.save(
        torch.manual_seed(3) and models.AssetForecaster(config),
        directory=str(directory),
        filename=filename,
        kind=models.AssetForecaster.kind,
        hyperparameters=config.as_dict(),
        feature_spec=SPEC.as_dict(),
        provenance={"origin": "synthetic", "seed": 11},
    )


def register(connection, tmp_path, *, version, mae, filename=None):
    dataset_id = make_dataset(connection)
    run_id = registry.start_run(
        connection,
        dataset_id=dataset_id,
        model_name="asset_power_forecast",
        model_kind=models.AssetForecaster.kind,
        framework="pytorch",
        framework_version=torch.__version__,
        compute="local",
        hyperparameters={"hidden": 8},
        epochs_requested=2,
        runner="pytest",
        trigger="manual",
    )
    stored = store_checkpoint(tmp_path, filename or f"{version}.pt")
    model_id = registry.complete_run(
        connection,
        run_id=run_id,
        dataset_id=dataset_id,
        model_name="asset_power_forecast",
        model_kind=models.AssetForecaster.kind,
        model_type="load_forecast",
        version=version,
        framework="pytorch",
        checkpoint_path=stored.path,
        checkpoint_digest=stored.digest,
        checkpoint_bytes=stored.bytes_written,
        hyperparameters={"hidden": 8},
        feature_spec=SPEC.as_dict(),
        metrics={"val_mae_w": mae, "persistence_mae_w": 500.0},
        epochs_ran=2,
        best_epoch=1,
        train_loss=0.1,
        val_loss=0.2,
        train_sequences=700,
        val_sequences=200,
        split_at=START + timedelta(days=5),
        training_data_start=START,
        training_data_end=END,
        training_samples=900,
        feature_statistics={
            name: {
                "mean": 0.1,
                "std": 0.2,
                "p05": 0.0,
                "p50": 0.1,
                "p95": 0.5,
                "bin_edges": [0.0, 0.5, 1.0],
                "bin_shares": [0.5, 0.5],
                "sample_count": 700,
            }
            for name in features.FEATURE_NAMES
        },
    )
    return model_id, stored


def seed_platform_telemetry(connection, *, hours=24 * 14, seed=5, solar=2, battery=1, meter=1):
    """Write generated rows into the platform `assets`/`telemetry` tables.

    The rows are synthetic, and a dataset built from them is still recorded as
    `platform` origin — which is honest, because that is where the trainer read them.
    What the platform must never do is the reverse: label generated data as fleet
    telemetry it never measured.
    """
    fleet = synthetic.build_fleet(seed, solar_sites=solar, battery_sites=battery, meter_sites=meter)
    end = datetime.utcnow().replace(second=0, microsecond=0)
    start = end - timedelta(hours=hours)
    columns = synthetic.generate(fleet, start=start, hours=hours, interval_minutes=15)

    with connection.cursor() as cursor:
        for asset in fleet.assets:
            cursor.execute(
                """
                INSERT INTO assets ("id", "userId", "assetType", "name", "capacity", "status",
                                    "approvalStatus")
                VALUES (%s, 1, %s, %s, %s, 'active', 'approved')
                ON CONFLICT ("id") DO NOTHING
                """,
                (asset.asset_id, asset.kind, f"{asset.kind}-{asset.asset_id}", asset.capacity_w),
            )
        rows = list(
            zip(
                columns["assetId"],
                columns["timestamp"],
                columns["power"],
                columns["energy"],
                columns["stateOfCharge"],
                columns["voltage"],
            )
        )
        cursor.executemany(
            """
            INSERT INTO telemetry ("assetId", "timestamp", "power", "energy", "stateOfCharge",
                                   "voltage")
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            rows,
        )
    connection.commit()
    return fleet, len(rows)
