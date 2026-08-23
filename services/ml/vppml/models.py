"""The models themselves: real `torch.nn.Module`s, trained by gradient descent.

Two of them, because the platform asks two different questions.

`AssetForecaster` predicts one asset's next `horizon` steps from its own history
(an LSTM encoder over the feature sequence, a linear head per horizon step). This
is what a member sees as their forecast, and what forecast accuracy is measured
against.

`TopologyGNN` predicts the *feeder's* next steps, which is not the sum of the
asset forecasts: a feeder's load depends on which assets sit under it and on the
substation above it. Each asset is a node with its own GRU over its history; node
states are then passed along the real `grid_nodes` edges — asset → feeder →
substation and back down — before a head reads each feeder's prediction. The
message passing is written directly against a normalised adjacency matrix rather
than pulled in from `torch_geometric`, so the graph is the platform's own topology
table and there is no extra dependency to keep aligned with it.

Neither model has an untrained inference path: `predict()` is only ever called on
weights loaded from a registered checkpoint, and the registry refuses to serve a
version whose artifact digest does not match.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import torch
from torch import nn


@dataclass(frozen=True)
class ForecasterConfig:
    features: int
    lookback: int
    horizon: int
    hidden: int = 64
    layers: int = 2
    dropout: float = 0.1

    def as_dict(self) -> dict[str, Any]:
        return {
            "features": self.features,
            "lookback": self.lookback,
            "horizon": self.horizon,
            "hidden": self.hidden,
            "layers": self.layers,
            "dropout": self.dropout,
        }


class AssetForecaster(nn.Module):
    """LSTM encoder → multi-horizon head. Predicts normalised power per step."""

    kind = "asset_forecaster"

    def __init__(self, config: ForecasterConfig) -> None:
        super().__init__()
        self.config = config
        self.encoder = nn.LSTM(
            input_size=config.features,
            hidden_size=config.hidden,
            num_layers=config.layers,
            batch_first=True,
            dropout=config.dropout if config.layers > 1 else 0.0,
        )
        self.norm = nn.LayerNorm(config.hidden)
        self.head = nn.Sequential(
            nn.Linear(config.hidden, config.hidden),
            nn.GELU(),
            nn.Dropout(config.dropout),
            nn.Linear(config.hidden, config.horizon),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        encoded, _ = self.encoder(x)
        # The last step's state summarises the window; earlier steps reach the head
        # through the recurrence rather than through a pooled average, which would
        # blur the most recent reading the forecast depends on most.
        return self.head(self.norm(encoded[:, -1, :]))


@dataclass(frozen=True)
class GNNConfig:
    features: int
    lookback: int
    horizon: int
    hidden: int = 48
    passes: int = 2
    dropout: float = 0.1

    def as_dict(self) -> dict[str, Any]:
        return {
            "features": self.features,
            "lookback": self.lookback,
            "horizon": self.horizon,
            "hidden": self.hidden,
            "passes": self.passes,
            "dropout": self.dropout,
        }


class TopologyGNN(nn.Module):
    """Per-node GRU encoder, then `passes` rounds of message passing over the
    platform's own node adjacency, then a per-node multi-horizon head.

    `adjacency` is a dense, symmetrically normalised (A + I) matrix of shape
    (nodes, nodes). Dense is deliberate: a distribution network's node count is in
    the hundreds, and a dense matmul keeps the graph a single readable tensor that
    can be asserted against `grid_nodes` in a test.
    """

    kind = "topology_gnn"

    def __init__(self, config: GNNConfig) -> None:
        super().__init__()
        self.config = config
        self.encoder = nn.GRU(
            input_size=config.features,
            hidden_size=config.hidden,
            batch_first=True,
        )
        self.message = nn.ModuleList(
            [nn.Linear(config.hidden, config.hidden) for _ in range(config.passes)]
        )
        self.update = nn.ModuleList(
            [nn.Linear(2 * config.hidden, config.hidden) for _ in range(config.passes)]
        )
        self.dropout = nn.Dropout(config.dropout)
        self.head = nn.Sequential(
            nn.Linear(config.hidden, config.hidden),
            nn.GELU(),
            nn.Linear(config.hidden, config.horizon),
        )

    def forward(self, x: torch.Tensor, adjacency: torch.Tensor) -> torch.Tensor:
        """x: (batch, nodes, lookback, features) → (batch, nodes, horizon)."""
        batch, nodes, lookback, features = x.shape
        encoded, _ = self.encoder(x.reshape(batch * nodes, lookback, features))
        state = encoded[:, -1, :].reshape(batch, nodes, -1)

        for message, update in zip(self.message, self.update):
            # Neighbour aggregation over the normalised adjacency, then a residual
            # update, so a node whose neighbours are silent keeps its own state.
            neighbours = torch.matmul(adjacency, message(state))
            state = torch.relu(update(torch.cat([state, neighbours], dim=-1))) + state
            state = self.dropout(state)

        return self.head(state)


def normalised_adjacency(
    node_ids: list[int],
    edges: list[tuple[int, int]],
    *,
    device: Optional[torch.device] = None,
) -> torch.Tensor:
    """Symmetrically normalised (A + I) for the given nodes.

    Edges naming a node that is not in `node_ids` raise: silently dropping one
    would train the model on a different topology than the one recorded, and the
    graph is the whole point of this model.
    """
    index = {node_id: position for position, node_id in enumerate(node_ids)}
    size = len(node_ids)
    if size == 0:
        raise ValueError("a graph needs at least one node")
    matrix = torch.eye(size, dtype=torch.float32, device=device)
    for left, right in edges:
        if left not in index or right not in index:
            raise ValueError(f"edge ({left}, {right}) names a node outside the graph")
        matrix[index[left], index[right]] = 1.0
        matrix[index[right], index[left]] = 1.0
    degree = matrix.sum(dim=1)
    inverse_sqrt = torch.diag(torch.pow(degree, -0.5))
    return inverse_sqrt @ matrix @ inverse_sqrt


#: Kinds this module can rebuild from a checkpoint's recorded hyperparameters.
KINDS = (AssetForecaster.kind, TopologyGNN.kind)


def build(kind: str, config: dict[str, Any]) -> nn.Module:
    """Rebuild a model from the hyperparameters a checkpoint recorded."""
    if kind == AssetForecaster.kind:
        return AssetForecaster(ForecasterConfig(**config))
    if kind == TopologyGNN.kind:
        return TopologyGNN(GNNConfig(**config))
    raise ValueError(f"unknown model kind {kind!r}")


def parameter_count(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())
