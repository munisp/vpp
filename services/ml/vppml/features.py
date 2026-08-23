"""Turning telemetry rows into supervised sequences, without inventing any.

Two rules decide everything in this module.

**A gap is not a value.** Telemetry arrives late, or not at all; a silent asset
produces no row. A window whose timestamps are not a contiguous run at the
expected interval is *dropped*, and the count is reported as `skipped_gaps`. The
alternative — forward-filling or zero-filling — teaches the model that an outage
looks like a flat load, which is exactly the pattern it would then predict during
the next outage.

**A missing channel is marked, not defaulted.** A solar asset reports no state of
charge, and a battery sometimes reports none either. Rather than substituting a
number, every optional channel is paired with a presence flag: the model is told
"no value here", and `soc_present=0` is a feature rather than a lie.

The feature order is fixed by `FEATURE_NAMES` and hashed into the dataset's
`feature_spec_digest`, so two datasets can only be compared, or a checkpoint
loaded against fresh features, when the ordering matches.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional, Sequence

#: Order matters and is part of the dataset digest.
FEATURE_NAMES: tuple[str, ...] = (
    "power_norm",
    "energy_delta_norm",
    "soc_fraction",
    "soc_present",
    "hour_sin",
    "hour_cos",
    "weekday_sin",
    "weekday_cos",
    "kind_solar",
    "kind_battery",
    "kind_meter",
)


@dataclass(frozen=True)
class FeatureSpec:
    lookback: int
    horizon: int
    interval_minutes: int
    feature_names: tuple[str, ...] = FEATURE_NAMES

    def as_dict(self) -> dict[str, Any]:
        return {
            "lookback": self.lookback,
            "horizon": self.horizon,
            "interval_minutes": self.interval_minutes,
            "features": list(self.feature_names),
            "label": "power_norm",
        }

    def digest(self) -> str:
        return hashlib.sha256(
            json.dumps(self.as_dict(), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()


@dataclass
class SequenceSet:
    """Sequences ready for training, in time order (never shuffled here: the split
    is by time, and shuffling before splitting would leak the future)."""

    spec: FeatureSpec
    #: (n, lookback, features)
    x: Any
    #: (n, horizon)
    y: Any
    #: Normalisation divisor per sequence, in watts, to read predictions back.
    scale: Any
    #: Entity (asset) id per sequence.
    entity: Any
    #: Timestamp of the first predicted step per sequence.
    target_at: list[datetime]
    rows_read: int
    skipped_gaps: int
    entities: int

    def __len__(self) -> int:
        return 0 if self.x is None else int(self.x.shape[0])


def _kind_flags(kind: Optional[str]) -> tuple[float, float, float]:
    return (
        1.0 if kind == "solar" else 0.0,
        1.0 if kind == "battery" else 0.0,
        1.0 if kind == "meter" else 0.0,
    )


def _as_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    raise TypeError(f"timestamp column holds {type(value).__name__}, expected datetime")


def build_sequences(
    columns: dict[str, Sequence[Any]],
    spec: FeatureSpec,
    *,
    asset_kinds: dict[int, str],
    asset_capacities: dict[int, int],
) -> SequenceSet:
    """Build (lookback -> horizon) sequences per asset from telemetry columns.

    Power is normalised per asset by its declared capacity, so one model spans a
    fleet of different sizes; `scale` carries the divisor so a prediction can be
    read back in watts rather than in a normalised unit nobody settles in.
    """
    import numpy as np  # noqa: PLC0415

    required = ("assetId", "timestamp", "power")
    missing = [name for name in required if name not in columns]
    if missing:
        raise ValueError(f"telemetry columns missing: {', '.join(missing)}")

    asset_ids = list(columns["assetId"])
    timestamps = [_as_datetime(value) for value in columns["timestamp"]]
    powers = list(columns["power"])
    energies = list(columns.get("energy", [None] * len(asset_ids)))
    socs = list(columns.get("stateOfCharge", [None] * len(asset_ids)))

    per_asset: dict[int, list[tuple[datetime, Any, Any, Any]]] = {}
    for index, asset_id in enumerate(asset_ids):
        if asset_id is None:
            continue
        per_asset.setdefault(int(asset_id), []).append(
            (timestamps[index], powers[index], energies[index], socs[index])
        )

    interval = timedelta(minutes=spec.interval_minutes)
    window = spec.lookback + spec.horizon

    features: list[list[list[float]]] = []
    labels: list[list[float]] = []
    scales: list[float] = []
    entities: list[int] = []
    target_at: list[datetime] = []
    skipped_gaps = 0
    rows_read = 0

    for asset_id, samples in sorted(per_asset.items()):
        samples.sort(key=lambda row: row[0])
        # Same instant reported twice (a replayed spool batch, a re-ingested
        # object): keep the first and drop the duplicate rather than treating it as
        # a second interval, which would shift every later step in the window.
        deduped: list[tuple[datetime, Any, Any, Any]] = []
        for sample in samples:
            if deduped and deduped[-1][0] == sample[0]:
                continue
            deduped.append(sample)
        rows_read += len(deduped)

        capacity = float(asset_capacities.get(asset_id, 0) or 0)
        if capacity <= 0:
            # Without a capacity there is no honest normalisation for this asset;
            # its rows are counted as read and excluded from training.
            continue
        kind_flags = _kind_flags(asset_kinds.get(asset_id))

        for start in range(0, max(0, len(deduped) - window + 1)):
            chunk = deduped[start : start + window]
            contiguous = all(
                chunk[index + 1][0] - chunk[index][0] == interval for index in range(len(chunk) - 1)
            )
            if not contiguous:
                skipped_gaps += 1
                continue
            if any(row[1] is None for row in chunk):
                # A row exists but carries no power reading: that is a missing
                # label, not a zero.
                skipped_gaps += 1
                continue

            history = chunk[: spec.lookback]
            future = chunk[spec.lookback :]
            rows: list[list[float]] = []
            previous_energy: Optional[float] = None
            for at, power, energy, soc in history:
                power_norm = float(power) / capacity
                if energy is None or previous_energy is None:
                    energy_delta = 0.0
                else:
                    energy_delta = (float(energy) - previous_energy) / max(capacity, 1.0)
                previous_energy = None if energy is None else float(energy)
                soc_present = 0.0 if soc is None else 1.0
                soc_fraction = 0.0 if soc is None else float(soc) / 100.0
                hour = at.hour + at.minute / 60.0
                rows.append(
                    [
                        power_norm,
                        energy_delta,
                        soc_fraction,
                        soc_present,
                        float(np.sin(2 * np.pi * hour / 24.0)),
                        float(np.cos(2 * np.pi * hour / 24.0)),
                        float(np.sin(2 * np.pi * at.weekday() / 7.0)),
                        float(np.cos(2 * np.pi * at.weekday() / 7.0)),
                        *kind_flags,
                    ]
                )

            features.append(rows)
            labels.append([float(row[1]) / capacity for row in future])
            scales.append(capacity)
            entities.append(asset_id)
            target_at.append(future[0][0])

    if not features:
        return SequenceSet(
            spec=spec,
            x=None,
            y=None,
            scale=None,
            entity=None,
            target_at=[],
            rows_read=rows_read,
            skipped_gaps=skipped_gaps,
            entities=len(per_asset),
        )

    order = sorted(range(len(target_at)), key=lambda index: (target_at[index], entities[index]))
    x = np.asarray([features[index] for index in order], dtype="float32")
    y = np.asarray([labels[index] for index in order], dtype="float32")
    scale = np.asarray([scales[index] for index in order], dtype="float32")
    entity = np.asarray([entities[index] for index in order], dtype="int64")
    return SequenceSet(
        spec=spec,
        x=x,
        y=y,
        scale=scale,
        entity=entity,
        target_at=[target_at[index] for index in order],
        rows_read=rows_read,
        skipped_gaps=skipped_gaps,
        entities=len({int(value) for value in entity}),
    )


def time_split(sequences: SequenceSet, val_fraction: float = 0.2) -> tuple[Any, Any, Any, Any, Optional[datetime]]:
    """Split by time, not at random: the validation set is strictly later than the
    training set, so a reported validation error is a forecast error rather than an
    interpolation error."""
    if len(sequences) == 0:
        return None, None, None, None, None
    total = len(sequences)
    cut = max(1, int(total * (1.0 - val_fraction)))
    if cut >= total:
        cut = total - 1
    if cut < 1:
        return None, None, None, None, None
    split_at = sequences.target_at[cut]
    return (
        sequences.x[:cut],
        sequences.y[:cut],
        sequences.x[cut:],
        sequences.y[cut:],
        split_at,
    )


def feature_statistics(
    x: Any, feature_names: Sequence[str] = FEATURE_NAMES
) -> dict[str, dict[str, Any]]:
    """Per-feature distribution of the training tensor, as drift will be measured
    against it: moments, percentiles and a fixed-edge histogram."""
    import numpy as np  # noqa: PLC0415

    flat = x.reshape(-1, x.shape[-1])
    if flat.shape[-1] != len(feature_names):
        raise ValueError(
            f"{flat.shape[-1]} feature column(s) but {len(feature_names)} name(s); a baseline whose"
            " columns are mislabelled would compare the wrong distributions later"
        )
    stats: dict[str, dict[str, Any]] = {}
    for index, name in enumerate(feature_names):
        values = flat[:, index].astype("float64")
        p05, p50, p95 = (float(value) for value in np.percentile(values, [5, 50, 95]))
        low = float(values.min())
        high = float(values.max())
        if high <= low:
            # A constant feature has no spread to bin; one bin holding everything is
            # the truthful description, and PSI against it stays defined.
            edges = [low, low + 1e-9]
            shares = [1.0]
        else:
            counts, edge_array = np.histogram(values, bins=10, range=(low, high))
            edges = [float(edge) for edge in edge_array]
            total = float(counts.sum()) or 1.0
            shares = [float(count) / total for count in counts]
        stats[name] = {
            "mean": float(values.mean()),
            "std": float(values.std()),
            "p05": p05,
            "p50": p50,
            "p95": p95,
            "bin_edges": edges,
            "bin_shares": shares,
            "sample_count": int(values.size),
        }
    return stats
