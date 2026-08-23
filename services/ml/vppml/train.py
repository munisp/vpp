"""The training loop. Real gradients, a time-ordered split, and a refusal when
there is not enough data to learn from.

What makes the reported numbers trustworthy is not the loop — it is what the loop
declines to do:

* **The split is by time.** Validation sequences all target instants later than
  every training sequence, so `val_mae_w` is a forecast error. A shuffled split
  would report interpolation error and look two to three times better.
* **Too little data is a refusal, not a small model.** Below
  `MIN_TRAIN_SEQUENCES`/`MIN_VAL_SEQUENCES` the run is stored as `refused` with the
  count it found. A model fitted on a handful of windows would still produce
  confident predictions.
* **MAPE is reported with its coverage.** Percentage error is undefined near zero
  power, which is most of a solar asset's day, so it is computed only over
  sequences whose actual magnitude clears `MAPE_FLOOR_W` and the share of
  sequences that qualified is reported alongside it.
* **Nothing is registered before the checkpoint is verified.** Weights are
  written, re-read, hashed; only then does a `model_registry` row exist.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import torch
from torch import nn

from . import checkpoints, data, features, models, registry
from .config import Config
from .data import DataError, TrainingSource
from .features import FeatureSpec

logger = logging.getLogger(__name__)

MIN_TRAIN_SEQUENCES = 200
MIN_VAL_SEQUENCES = 40
#: Below this magnitude a percentage error says more about the divisor than the model.
MAPE_FLOOR_W = 50.0


@dataclass(frozen=True)
class TrainingConfig:
    model_name: str = "asset_power_forecast"
    lookback: int = 24
    horizon: int = 4
    interval_minutes: int = 15
    hidden: int = 64
    layers: int = 2
    dropout: float = 0.1
    batch_size: int = 64
    epochs: int = 30
    learning_rate: float = 1e-3
    weight_decay: float = 1e-5
    #: Stop when validation loss has not improved for this many epochs.
    patience: int = 5
    seed: int = 7

    def hyperparameters(self) -> dict[str, Any]:
        return {
            "lookback": self.lookback,
            "horizon": self.horizon,
            "interval_minutes": self.interval_minutes,
            "hidden": self.hidden,
            "layers": self.layers,
            "dropout": self.dropout,
            "batch_size": self.batch_size,
            "epochs": self.epochs,
            "learning_rate": self.learning_rate,
            "weight_decay": self.weight_decay,
            "patience": self.patience,
            "seed": self.seed,
        }


@dataclass
class TrainingOutcome:
    state: str  # 'succeeded' | 'refused' | 'failed'
    run_id: Optional[int] = None
    model_id: Optional[int] = None
    version: Optional[str] = None
    metrics: dict[str, float] = None  # type: ignore[assignment]
    refusal_reason: Optional[str] = None
    error: Optional[str] = None
    detail: str = ""


def _metrics(
    predictions: torch.Tensor, actuals: torch.Tensor, scale: torch.Tensor
) -> dict[str, float]:
    """Errors in watts, because that is the unit anyone acts on."""
    scale_column = scale.reshape(-1, 1)
    predicted_w = predictions * scale_column
    actual_w = actuals * scale_column
    error = predicted_w - actual_w

    mae = float(error.abs().mean().item())
    rmse = float(torch.sqrt((error**2).mean()).item())

    magnitude = actual_w.abs()
    usable = magnitude >= MAPE_FLOOR_W
    usable_count = int(usable.sum().item())
    total = int(magnitude.numel())
    if usable_count > 0:
        mape = float(((error[usable].abs() / magnitude[usable]).mean() * 100).item())
    else:
        mape = float("nan")

    # A model that predicts the last observed value is the bar any forecast has to
    # clear; reporting the ratio stops "MAE 40 W" from sounding good on its own.
    return {
        "val_mae_w": mae,
        "val_rmse_w": rmse,
        "val_mape_percent": mape,
        "val_mape_coverage": (usable_count / total) if total else 0.0,
        "val_points": float(total),
    }


def _persistence_baseline(x: torch.Tensor, y: torch.Tensor, scale: torch.Tensor) -> float:
    """MAE in watts of "the next steps equal the last observed step"."""
    last = x[:, -1, 0].reshape(-1, 1)
    error = (last - y) * scale.reshape(-1, 1)
    return float(error.abs().mean().item())


def train_forecaster(
    connection: Any,
    config: Config,
    training: TrainingConfig,
    *,
    origin: str,
    window_start: datetime,
    window_end: datetime,
    seed: Optional[int] = None,
    trigger: str = "manual",
    retraining_job_id: Optional[str] = None,
    compute: Optional[str] = None,
) -> TrainingOutcome:
    """Build the dataset, train, and register the version — or refuse, on the record."""
    torch.manual_seed(training.seed)

    try:
        source: TrainingSource = data.resolve(
            connection,
            config,
            origin,
            window_start=window_start,
            window_end=window_end,
            seed=seed,
            interval_minutes=training.interval_minutes,
        )
    except DataError as exc:
        # No dataset row is written: there is no dataset. The caller records the
        # refusal against the job that asked for it.
        return TrainingOutcome(state="refused", refusal_reason=str(exc)[:600], detail=str(exc))

    spec = FeatureSpec(
        lookback=training.lookback,
        horizon=training.horizon,
        interval_minutes=training.interval_minutes,
    )
    sequences = features.build_sequences(
        source.columns,
        spec,
        asset_kinds=source.asset_kinds,
        asset_capacities=source.asset_capacities,
    )

    if len(sequences) == 0:
        reason = (
            f"{source.origin}: {sequences.rows_read} row(s) produced no usable "
            f"{spec.lookback}+{spec.horizon} step window "
            f"({sequences.skipped_gaps} candidate window(s) dropped for gaps or missing power). "
            "Nothing was trained."
        )
        return TrainingOutcome(state="refused", refusal_reason=reason[:600], detail=reason)

    x_train, y_train, x_val, y_val, split_at = features.time_split(sequences)
    if x_train is None or x_val is None:
        reason = f"{source.origin}: {len(sequences)} sequence(s) cannot be split into train and validation"
        return TrainingOutcome(state="refused", refusal_reason=reason[:600], detail=reason)

    if len(x_train) < MIN_TRAIN_SEQUENCES or len(x_val) < MIN_VAL_SEQUENCES:
        reason = (
            f"{source.origin}: {len(x_train)} training and {len(x_val)} validation sequence(s) is "
            f"below the {MIN_TRAIN_SEQUENCES}/{MIN_VAL_SEQUENCES} minimum. A model fitted on this "
            "would still produce confident forecasts, so the run refuses instead."
        )
        return TrainingOutcome(state="refused", refusal_reason=reason[:600], detail=reason)

    dataset_id = registry.insert_dataset(
        connection,
        name=f"{training.model_name}:{source.origin}",
        origin=source.origin,
        task="asset_power_forecast",
        feature_spec=spec.as_dict(),
        feature_spec_digest=spec.digest(),
        window_start=window_start,
        window_end=window_end,
        rows=sequences.rows_read,
        sequences=len(sequences),
        entities=sequences.entities,
        source_objects=source.object_keys,
        source_digests=source.object_digests,
        generator=source.generator,
        generator_version=source.generator_version,
        seed=source.seed,
        created_by=config.runner,
    )

    model_config = models.ForecasterConfig(
        features=len(features.FEATURE_NAMES),
        lookback=training.lookback,
        horizon=training.horizon,
        hidden=training.hidden,
        layers=training.layers,
        dropout=training.dropout,
    )
    run_id = registry.start_run(
        connection,
        dataset_id=dataset_id,
        model_name=training.model_name,
        model_kind=models.AssetForecaster.kind,
        framework="pytorch",
        framework_version=torch.__version__,
        compute=compute or ("ray:" + config.ray_address if config.uses_ray else "local"),
        hyperparameters={**training.hyperparameters(), **model_config.as_dict()},
        epochs_requested=training.epochs,
        runner=config.runner,
        trigger=trigger,
        retraining_job_id=retraining_job_id,
    )

    try:
        model = models.AssetForecaster(model_config)
        result = fit(
            model,
            x_train=x_train,
            y_train=y_train,
            x_val=x_val,
            y_val=y_val,
            training=training,
        )

        scale_val = torch.from_numpy(sequences.scale[len(x_train) :])
        with torch.no_grad():
            model.eval()
            predictions = model(torch.from_numpy(x_val))
        metrics = _metrics(predictions, torch.from_numpy(y_val), scale_val)
        metrics["persistence_mae_w"] = _persistence_baseline(
            torch.from_numpy(x_val), torch.from_numpy(y_val), scale_val
        )
        metrics["train_loss"] = result.train_loss
        metrics["val_loss"] = result.val_loss

        version = registry.next_version(connection, training.model_name)
        stored = checkpoints.save(
            model,
            directory=config.artifact_dir,
            filename=f"{training.model_name}-{version}.pt",
            kind=models.AssetForecaster.kind,
            hyperparameters=model_config.as_dict(),
            feature_spec=spec.as_dict(),
            provenance={
                "dataset_id": dataset_id,
                "origin": source.origin,
                "training_run_id": run_id,
                "source_objects": source.object_keys,
                "seed": source.seed,
                "generator": source.generator,
                "generator_version": source.generator_version,
            },
        )

        model_id = registry.complete_run(
            connection,
            run_id=run_id,
            dataset_id=dataset_id,
            model_name=training.model_name,
            model_kind=models.AssetForecaster.kind,
            # `model_registry_model_type` predates this service; an asset power forecast
            # is stored as `load_forecast`, the closest existing member of that enum.
            model_type="load_forecast",
            version=version,
            framework="pytorch",
            checkpoint_path=stored.path,
            checkpoint_digest=stored.digest,
            checkpoint_bytes=stored.bytes_written,
            hyperparameters={**training.hyperparameters(), **model_config.as_dict()},
            feature_spec=spec.as_dict(),
            metrics=metrics,
            epochs_ran=result.epochs_ran,
            best_epoch=result.best_epoch,
            train_loss=result.train_loss,
            val_loss=result.val_loss,
            train_sequences=len(x_train),
            val_sequences=len(x_val),
            split_at=split_at,
            training_data_start=window_start,
            training_data_end=window_end,
            training_samples=len(sequences),
            feature_statistics=features.feature_statistics(x_train),
        )
    except Exception as exc:  # noqa: BLE001 - recorded, then re-raised to the caller
        registry.fail_run(connection, run_id, f"{type(exc).__name__}: {exc}")
        return TrainingOutcome(
            state="failed", run_id=run_id, error=f"{type(exc).__name__}: {exc}", detail=str(exc)
        )

    detail = (
        f"{training.model_name} {version}: val MAE {metrics['val_mae_w']:.1f} W vs persistence "
        f"{metrics['persistence_mae_w']:.1f} W over {len(x_val)} held-out sequence(s); "
        f"{source.detail}"
    )
    logger.info("%s", detail)
    return TrainingOutcome(
        state="succeeded",
        run_id=run_id,
        model_id=model_id,
        version=version,
        metrics=metrics,
        detail=detail,
    )


@dataclass
class FitResult:
    epochs_ran: int
    best_epoch: int
    train_loss: float
    val_loss: float


def fit(
    model: nn.Module,
    *,
    x_train: Any,
    y_train: Any,
    x_val: Any,
    y_val: Any,
    training: TrainingConfig,
) -> FitResult:
    """Minimise Huber loss on the training sequences, keeping the weights from the
    best validation epoch (not the last one, which is usually overfit)."""
    device = torch.device("cpu")
    model.to(device)
    optimiser = torch.optim.AdamW(
        model.parameters(), lr=training.learning_rate, weight_decay=training.weight_decay
    )
    loss_fn = nn.HuberLoss(delta=0.1)

    train_x = torch.from_numpy(x_train)
    train_y = torch.from_numpy(y_train)
    val_x = torch.from_numpy(x_val)
    val_y = torch.from_numpy(y_val)

    best_val = math.inf
    best_epoch = 0
    best_state: dict[str, torch.Tensor] = {
        key: value.detach().clone() for key, value in model.state_dict().items()
    }
    last_train_loss = math.inf
    epochs_ran = 0
    since_improvement = 0

    for epoch in range(1, training.epochs + 1):
        model.train()
        # Batches are contiguous slices in time order; the model sees each sequence
        # once per epoch and no sequence is paired with a later one it should not
        # have seen.
        total = 0.0
        batches = 0
        for start in range(0, len(train_x), training.batch_size):
            batch_x = train_x[start : start + training.batch_size]
            batch_y = train_y[start : start + training.batch_size]
            optimiser.zero_grad()
            loss = loss_fn(model(batch_x), batch_y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimiser.step()
            total += float(loss.item())
            batches += 1
        last_train_loss = total / max(1, batches)

        model.eval()
        with torch.no_grad():
            val_loss = float(loss_fn(model(val_x), val_y).item())
        epochs_ran = epoch

        if val_loss < best_val - 1e-6:
            best_val = val_loss
            best_epoch = epoch
            best_state = {
                key: value.detach().clone() for key, value in model.state_dict().items()
            }
            since_improvement = 0
        else:
            since_improvement += 1
            if since_improvement >= training.patience:
                break

    model.load_state_dict(best_state)
    return FitResult(
        epochs_ran=epochs_ran,
        best_epoch=best_epoch or 1,
        train_loss=last_train_loss,
        val_loss=best_val,
    )


def default_window(hours: int = 24 * 14, *, now: Optional[datetime] = None) -> tuple[datetime, datetime]:
    end = (now or datetime.now(timezone.utc)).replace(tzinfo=None)
    return end - timedelta(hours=hours), end
