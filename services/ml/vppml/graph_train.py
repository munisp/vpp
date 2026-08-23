"""Training the topology model, on the graph the platform actually recorded.

Same discipline as the asset forecaster — time-ordered split, refusal below a
minimum, checkpoint verified before registration — with one addition: the
adjacency is built from `grid_nodes`/`grid_node_assets` and stored in the
checkpoint alongside the node order. A GNN loaded against a different node order
would be reading another feeder's history into this feeder's state, so
`node_ids` travels with the weights and inference compares it.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

import torch
from torch import nn

from . import checkpoints, data, features, graph, models, registry
from .config import Config
from .data import DataError
from .train import TrainingOutcome

logger = logging.getLogger(__name__)

#: Graph windows are far fewer than asset windows (one per instant, not one per
#: asset per instant), so the floor is lower — but still a floor.
MIN_GRAPH_TRAIN_WINDOWS = 120
MIN_GRAPH_VAL_WINDOWS = 24


@dataclass(frozen=True)
class GraphTrainingConfig:
    model_name: str = "feeder_power_forecast"
    lookback: int = 24
    horizon: int = 4
    interval_minutes: int = 15
    hidden: int = 48
    passes: int = 2
    dropout: float = 0.1
    batch_size: int = 16
    epochs: int = 40
    learning_rate: float = 2e-3
    weight_decay: float = 1e-5
    patience: int = 6
    seed: int = 7

    def hyperparameters(self) -> dict[str, Any]:
        return {
            "lookback": self.lookback,
            "horizon": self.horizon,
            "interval_minutes": self.interval_minutes,
            "hidden": self.hidden,
            "passes": self.passes,
            "dropout": self.dropout,
            "batch_size": self.batch_size,
            "epochs": self.epochs,
            "learning_rate": self.learning_rate,
            "weight_decay": self.weight_decay,
            "patience": self.patience,
            "seed": self.seed,
        }


def _spec_dict(config: GraphTrainingConfig, node_ids: list[int]) -> dict[str, Any]:
    return {
        "lookback": config.lookback,
        "horizon": config.horizon,
        "interval_minutes": config.interval_minutes,
        "features": list(graph.GRAPH_FEATURE_NAMES),
        "label": "node_power_norm",
        "node_ids": node_ids,
    }


def _digest(spec: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def train_topology_gnn(
    connection: Any,
    config: Config,
    training: GraphTrainingConfig,
    *,
    origin: str,
    window_start: datetime,
    window_end: datetime,
    seed: Optional[int] = None,
    trigger: str = "manual",
    retraining_job_id: Optional[str] = None,
    compute: Optional[str] = None,
) -> TrainingOutcome:
    torch.manual_seed(training.seed)

    try:
        source = data.resolve(
            connection,
            config,
            origin,
            window_start=window_start,
            window_end=window_end,
            seed=seed,
            interval_minutes=training.interval_minutes,
        )
    except DataError as exc:
        return TrainingOutcome(state="refused", refusal_reason=str(exc)[:600], detail=str(exc))

    if not source.asset_nodes:
        reason = (
            "no asset is linked to a grid node, so there is no topology to learn. Link assets in "
            "grid_node_assets before training the feeder model."
        )
        return TrainingOutcome(state="refused", refusal_reason=reason[:600], detail=reason)

    sequences = graph.build_graph_sequences(
        source.columns,
        asset_nodes=source.asset_nodes,
        node_parents=source.node_parents,
        asset_capacities=source.asset_capacities,
        lookback=training.lookback,
        horizon=training.horizon,
        interval_minutes=training.interval_minutes,
    )
    if len(sequences) == 0:
        reason = (
            f"{source.origin}: {sequences.rows_read} row(s) over {len(sequences.node_ids)} node(s) "
            f"produced no fully covered {training.lookback}+{training.horizon} step window "
            f"({sequences.dropped_steps} instant(s) dropped for partial node coverage)."
        )
        return TrainingOutcome(state="refused", refusal_reason=reason[:600], detail=reason)

    total = len(sequences)
    cut = max(1, int(total * 0.8))
    if cut >= total:
        cut = total - 1
    x_train, y_train = sequences.x[:cut], sequences.y[:cut]
    x_val, y_val = sequences.x[cut:], sequences.y[cut:]
    split_at = sequences.target_at[cut] if cut < len(sequences.target_at) else None

    if len(x_train) < MIN_GRAPH_TRAIN_WINDOWS or len(x_val) < MIN_GRAPH_VAL_WINDOWS:
        reason = (
            f"{source.origin}: {len(x_train)} training and {len(x_val)} validation graph window(s) "
            f"is below the {MIN_GRAPH_TRAIN_WINDOWS}/{MIN_GRAPH_VAL_WINDOWS} minimum."
        )
        return TrainingOutcome(state="refused", refusal_reason=reason[:600], detail=reason)

    spec = _spec_dict(training, sequences.node_ids)
    dataset_id = registry.insert_dataset(
        connection,
        name=f"{training.model_name}:{source.origin}",
        origin=source.origin,
        task="feeder_power_forecast",
        feature_spec=spec,
        feature_spec_digest=_digest(spec),
        window_start=window_start,
        window_end=window_end,
        rows=sequences.rows_read,
        sequences=total,
        entities=len(sequences.node_ids),
        source_objects=source.object_keys,
        source_digests=source.object_digests,
        generator=source.generator,
        generator_version=source.generator_version,
        seed=source.seed,
        created_by=config.runner,
    )

    model_config = models.GNNConfig(
        features=len(graph.GRAPH_FEATURE_NAMES),
        lookback=training.lookback,
        horizon=training.horizon,
        hidden=training.hidden,
        passes=training.passes,
        dropout=training.dropout,
    )
    run_id = registry.start_run(
        connection,
        dataset_id=dataset_id,
        model_name=training.model_name,
        model_kind=models.TopologyGNN.kind,
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
        adjacency = models.normalised_adjacency(sequences.node_ids, sequences.edges)
        model = models.TopologyGNN(model_config)
        result = _fit_graph(
            model,
            adjacency=adjacency,
            x_train=torch.from_numpy(x_train),
            y_train=torch.from_numpy(y_train),
            x_val=torch.from_numpy(x_val),
            y_val=torch.from_numpy(y_val),
            training=training,
        )

        node_scale = torch.from_numpy(sequences.node_scale).reshape(1, -1, 1)
        with torch.no_grad():
            model.eval()
            predictions = model(torch.from_numpy(x_val), adjacency)
        actual = torch.from_numpy(y_val)
        error = (predictions - actual) * node_scale
        last = torch.from_numpy(x_val)[:, :, -1, 0].unsqueeze(-1)
        persistence = ((last - actual) * node_scale).abs().mean()
        metrics = {
            "val_mae_w": float(error.abs().mean().item()),
            "val_rmse_w": float(torch.sqrt((error**2).mean()).item()),
            "persistence_mae_w": float(persistence.item()),
            "val_windows": float(len(x_val)),
            "nodes": float(len(sequences.node_ids)),
            "edges": float(len(sequences.edges)),
            "train_loss": result.train_loss,
            "val_loss": result.val_loss,
        }

        version = registry.next_version(connection, training.model_name)
        stored = checkpoints.save(
            model,
            directory=config.artifact_dir,
            filename=f"{training.model_name}-{version}.pt",
            kind=models.TopologyGNN.kind,
            hyperparameters=model_config.as_dict(),
            feature_spec=spec,
            provenance={
                "dataset_id": dataset_id,
                "training_run_id": run_id,
                "origin": source.origin,
                "node_ids": sequences.node_ids,
                "edges": sequences.edges,
                "source_objects": source.object_keys,
                "seed": source.seed,
            },
        )

        # Per-node feature statistics flattened across nodes: drift on a feeder model
        # is drift in the aggregate the model reads. Same routine as the asset model,
        # so the two baselines are computed and binned identically.
        statistics = features.feature_statistics(
            x_train.reshape(-1, x_train.shape[-1]), graph.GRAPH_FEATURE_NAMES
        )

        model_id = registry.complete_run(
            connection,
            run_id=run_id,
            dataset_id=dataset_id,
            model_name=training.model_name,
            model_kind=models.TopologyGNN.kind,
            model_type="load_forecast",
            version=version,
            framework="pytorch",
            checkpoint_path=stored.path,
            checkpoint_digest=stored.digest,
            checkpoint_bytes=stored.bytes_written,
            hyperparameters={**training.hyperparameters(), **model_config.as_dict()},
            feature_spec=spec,
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
            training_samples=total,
            feature_statistics=statistics,
        )
    except Exception as exc:  # noqa: BLE001
        registry.fail_run(connection, run_id, f"{type(exc).__name__}: {exc}")
        return TrainingOutcome(
            state="failed", run_id=run_id, error=f"{type(exc).__name__}: {exc}", detail=str(exc)
        )

    detail = (
        f"{training.model_name} {version}: val MAE {metrics['val_mae_w']:.1f} W vs persistence "
        f"{metrics['persistence_mae_w']:.1f} W over {len(x_val)} window(s), "
        f"{len(sequences.node_ids)} node(s) / {len(sequences.edges)} edge(s); {source.detail}"
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
class GraphFitResult:
    epochs_ran: int
    best_epoch: int
    train_loss: float
    val_loss: float


def _fit_graph(
    model: nn.Module,
    *,
    adjacency: torch.Tensor,
    x_train: torch.Tensor,
    y_train: torch.Tensor,
    x_val: torch.Tensor,
    y_val: torch.Tensor,
    training: GraphTrainingConfig,
) -> GraphFitResult:
    import math

    optimiser = torch.optim.AdamW(
        model.parameters(), lr=training.learning_rate, weight_decay=training.weight_decay
    )
    loss_fn = nn.HuberLoss(delta=0.1)
    best_val = math.inf
    best_epoch = 0
    best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
    last_train = math.inf
    epochs_ran = 0
    stale = 0

    for epoch in range(1, training.epochs + 1):
        model.train()
        total, batches = 0.0, 0
        for start in range(0, len(x_train), training.batch_size):
            batch_x = x_train[start : start + training.batch_size]
            batch_y = y_train[start : start + training.batch_size]
            optimiser.zero_grad()
            loss = loss_fn(model(batch_x, adjacency), batch_y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimiser.step()
            total += float(loss.item())
            batches += 1
        last_train = total / max(1, batches)

        model.eval()
        with torch.no_grad():
            val_loss = float(loss_fn(model(x_val, adjacency), y_val).item())
        epochs_ran = epoch
        if val_loss < best_val - 1e-6:
            best_val, best_epoch, stale = val_loss, epoch, 0
            best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
        else:
            stale += 1
            if stale >= training.patience:
                break

    model.load_state_dict(best_state)
    return GraphFitResult(
        epochs_ran=epochs_ran,
        best_epoch=best_epoch or 1,
        train_loss=last_train,
        val_loss=best_val,
    )
