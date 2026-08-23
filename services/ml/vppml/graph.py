"""Feeder-level sequences and the graph they live on.

A feeder's load is not the sum of the forecasts of the assets beneath it, and the
GNN exists to learn that difference. Building its training tensor honestly is
mostly a coverage problem:

* A node's power at an instant is the sum over the assets linked to it in
  `grid_node_assets`. If any linked asset did not report at that instant, the sum
  is **not** the node's power — it is the power of the assets that happened to
  report. Such an instant is dropped for that node and counted, never scaled up
  or filled in.
* The model reads all nodes at once, so a window is only usable when every node in
  the graph has coverage at every step of it. `usable_steps` and `dropped_steps`
  report how much of the window survived that, and a graph with too few usable
  windows is a refusal upstream rather than a small training set.
* Nodes with no linked assets carry no measurement and are excluded from the
  graph, rather than being included as a constant zero the model would learn to
  predict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Optional

GRAPH_FEATURE_NAMES: tuple[str, ...] = (
    "node_power_norm",
    "reporting_share",
    "hour_sin",
    "hour_cos",
    "weekday_sin",
    "weekday_cos",
)


@dataclass
class GraphSequences:
    node_ids: list[int]
    edges: list[tuple[int, int]]
    #: (windows, nodes, lookback, features)
    x: Any
    #: (windows, nodes, horizon)
    y: Any
    #: Watts divisor per node, to read predictions back.
    node_scale: Any
    target_at: list[datetime] = field(default_factory=list)
    usable_steps: int = 0
    dropped_steps: int = 0
    rows_read: int = 0

    def __len__(self) -> int:
        return 0 if self.x is None else int(self.x.shape[0])


def node_series(
    columns: dict[str, list[Any]],
    *,
    asset_nodes: dict[int, int],
    asset_capacities: dict[int, int],
    interval_minutes: int,
) -> tuple[dict[int, dict[datetime, float]], dict[int, int], dict[int, int], int, int]:
    """Sum asset power per node per instant, keeping only fully covered instants.

    Returns (series, node_capacity_w, node_asset_count, dropped, rows_read).
    """
    rows_read = 0
    per_node_assets: dict[int, set[int]] = {}
    for asset_id, node_id in asset_nodes.items():
        per_node_assets.setdefault(node_id, set()).add(asset_id)

    observed: dict[int, dict[datetime, dict[int, float]]] = {}
    asset_ids = columns.get("assetId", [])
    timestamps = columns.get("timestamp", [])
    powers = columns.get("power", [])
    for index, raw_asset in enumerate(asset_ids):
        if raw_asset is None:
            continue
        asset_id = int(raw_asset)
        node_id = asset_nodes.get(asset_id)
        if node_id is None:
            continue
        power = powers[index]
        if power is None:
            continue
        rows_read += 1
        observed.setdefault(node_id, {}).setdefault(timestamps[index], {})[asset_id] = float(power)

    node_capacity: dict[int, int] = {}
    node_assets: dict[int, int] = {}
    series: dict[int, dict[datetime, float]] = {}
    dropped = 0
    for node_id, by_time in observed.items():
        expected = per_node_assets.get(node_id, set())
        capacity = sum(int(asset_capacities.get(asset_id, 0) or 0) for asset_id in expected)
        if not expected or capacity <= 0:
            continue
        node_capacity[node_id] = capacity
        node_assets[node_id] = len(expected)
        kept: dict[datetime, float] = {}
        for at, readings in by_time.items():
            if set(readings) != expected:
                # Partial coverage: this is not the node's power.
                dropped += 1
                continue
            kept[at] = sum(readings.values())
        if kept:
            series[node_id] = kept
    return series, node_capacity, node_assets, dropped, rows_read


def build_graph_sequences(
    columns: dict[str, list[Any]],
    *,
    asset_nodes: dict[int, int],
    node_parents: dict[int, Optional[int]],
    asset_capacities: dict[int, int],
    lookback: int,
    horizon: int,
    interval_minutes: int,
) -> GraphSequences:
    import numpy as np  # noqa: PLC0415

    series, node_capacity, node_assets, dropped, rows_read = node_series(
        columns,
        asset_nodes=asset_nodes,
        asset_capacities=asset_capacities,
        interval_minutes=interval_minutes,
    )
    node_ids = sorted(series)
    if not node_ids:
        return GraphSequences(
            node_ids=[],
            edges=[],
            x=None,
            y=None,
            node_scale=None,
            dropped_steps=dropped,
            rows_read=rows_read,
        )

    # Instants where every measured node has full coverage. Anything else would mix
    # a node's real load with another node's absence.
    shared = set(series[node_ids[0]])
    for node_id in node_ids[1:]:
        shared &= set(series[node_id])
    axis = sorted(shared)

    # Parent edges among the nodes that are actually in the graph. A feeder whose
    # substation has no measured assets keeps no edge upward rather than gaining a
    # phantom neighbour.
    present = set(node_ids)
    edges = [
        (node_id, parent)
        for node_id, parent in node_parents.items()
        if parent is not None and node_id in present and parent in present
    ]

    interval = timedelta(minutes=interval_minutes)
    window = lookback + horizon
    features: list[list[list[list[float]]]] = []
    labels: list[list[list[float]]] = []
    target_at: list[datetime] = []

    for start in range(0, max(0, len(axis) - window + 1)):
        chunk = axis[start : start + window]
        if any(chunk[index + 1] - chunk[index] != interval for index in range(len(chunk) - 1)):
            continue
        history = chunk[:lookback]
        future = chunk[lookback:]
        per_node_x: list[list[list[float]]] = []
        per_node_y: list[list[float]] = []
        for node_id in node_ids:
            capacity = float(node_capacity[node_id])
            rows: list[list[float]] = []
            for at in history:
                hour = at.hour + at.minute / 60.0
                rows.append(
                    [
                        series[node_id][at] / capacity,
                        1.0,  # every step here is fully covered by construction
                        float(np.sin(2 * np.pi * hour / 24.0)),
                        float(np.cos(2 * np.pi * hour / 24.0)),
                        float(np.sin(2 * np.pi * at.weekday() / 7.0)),
                        float(np.cos(2 * np.pi * at.weekday() / 7.0)),
                    ]
                )
            per_node_x.append(rows)
            per_node_y.append([series[node_id][at] / capacity for at in future])
        features.append(per_node_x)
        labels.append(per_node_y)
        target_at.append(future[0])

    if not features:
        return GraphSequences(
            node_ids=node_ids,
            edges=edges,
            x=None,
            y=None,
            node_scale=None,
            usable_steps=len(axis),
            dropped_steps=dropped,
            rows_read=rows_read,
        )

    return GraphSequences(
        node_ids=node_ids,
        edges=edges,
        x=np.asarray(features, dtype="float32"),
        y=np.asarray(labels, dtype="float32"),
        node_scale=np.asarray([node_capacity[node_id] for node_id in node_ids], dtype="float32"),
        target_at=target_at,
        usable_steps=len(axis),
        dropped_steps=dropped,
        rows_read=rows_read,
    )
