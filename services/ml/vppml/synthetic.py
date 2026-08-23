"""A synthetic fleet, generated so a model has something with real structure to
learn — and labelled so nobody can mistake it for the fleet.

Synthetic training data is useful and dangerous for the same reason: it looks
exactly like platform data. Two properties keep it honest here.

1. **Reproducible from its provenance.** Every value is drawn from a generator
   seeded by `(seed, asset id, channel)`, so the dataset row's `seed` plus
   `generator_version` is enough to regenerate the tensors bit for bit. A run
   cannot claim a seed it did not use, because the check is `regenerate and
   compare`.
2. **Never mixed into platform data.** `generate()` returns rows tagged
   `origin='synthetic'`, and `training_datasets.origin` is an enum column with a
   constraint requiring generator/version/seed — a synthetic dataset cannot be
   stored as `platform`, and a platform dataset cannot borrow the generator's
   provenance.

The shapes are the physical ones the platform actually sees: a clear-sky solar
profile scaled by AR(1) cloud cover, household load with morning and evening
peaks and a weekday effect, and battery state of charge integrated from the site's
own net power rather than drawn independently (so SoC and power are consistent,
which is what makes the series learnable at all).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable, Literal, Optional

GENERATOR_NAME = "vppml.synthetic.fleet"
#: Bump when the emitted values change for a given seed. Datasets record it, so a
#: model trained under v1 is never compared against v2 data as if it were the same.
GENERATOR_VERSION = "1"

AssetKind = Literal["solar", "battery", "meter"]


@dataclass(frozen=True)
class SyntheticAsset:
    asset_id: int
    kind: AssetKind
    #: Watts. Solar peak output, battery power rating, meter service capacity.
    capacity_w: int
    node_id: int
    #: Battery only, Wh.
    storage_wh: int = 0


@dataclass
class SyntheticFleet:
    assets: list[SyntheticAsset]
    #: node id -> parent node id (None at the substation), the graph the GNN reads.
    node_parents: dict[int, Optional[int]]
    seed: int

    @property
    def node_ids(self) -> list[int]:
        return sorted(self.node_parents)


def _rng(seed: int, *parts: int | str):
    """A generator whose stream depends only on the seed and the named parts, so
    adding an asset does not change any other asset's series."""
    import numpy as np  # noqa: PLC0415

    mixed = [int(seed)]
    for part in parts:
        if isinstance(part, int):
            mixed.append(part)
        else:
            mixed.extend(ord(char) for char in part)
    return np.random.default_rng(mixed)


def build_fleet(
    seed: int,
    *,
    solar_sites: int = 12,
    battery_sites: int = 6,
    meter_sites: int = 12,
    feeders: int = 3,
) -> SyntheticFleet:
    """A fleet with a two-level topology: one substation, `feeders` feeders, assets
    attached to feeders. Sizes come from the seed, so two fleets from one seed are
    the same fleet."""
    rng = _rng(seed, "fleet")
    substation = 1
    node_parents: dict[int, Optional[int]] = {substation: None}
    feeder_ids = []
    for index in range(feeders):
        node_id = 100 + index
        node_parents[node_id] = substation
        feeder_ids.append(node_id)

    assets: list[SyntheticAsset] = []
    asset_id = 1
    for _ in range(solar_sites):
        assets.append(
            SyntheticAsset(
                asset_id=asset_id,
                kind="solar",
                capacity_w=int(rng.integers(2_000, 9_000)),
                node_id=int(feeder_ids[asset_id % len(feeder_ids)]),
            )
        )
        asset_id += 1
    for _ in range(battery_sites):
        rating = int(rng.integers(2_500, 6_000))
        assets.append(
            SyntheticAsset(
                asset_id=asset_id,
                kind="battery",
                capacity_w=rating,
                storage_wh=rating * int(rng.integers(2, 5)),
                node_id=int(feeder_ids[asset_id % len(feeder_ids)]),
            )
        )
        asset_id += 1
    for _ in range(meter_sites):
        assets.append(
            SyntheticAsset(
                asset_id=asset_id,
                kind="meter",
                capacity_w=int(rng.integers(3_000, 12_000)),
                node_id=int(feeder_ids[asset_id % len(feeder_ids)]),
            )
        )
        asset_id += 1

    return SyntheticFleet(assets=assets, node_parents=node_parents, seed=seed)


def _clear_sky(hour: float) -> float:
    """Fraction of peak output at a given local hour. Zero outside daylight."""
    if hour <= 6.0 or hour >= 18.5:
        return 0.0
    return max(0.0, math.sin(math.pi * (hour - 6.0) / 12.5))


def _household_shape(hour: float, weekday: int) -> float:
    """Fraction of service capacity drawn, with morning and evening peaks."""
    morning = math.exp(-((hour - 7.0) ** 2) / 2.0)
    evening = math.exp(-((hour - 19.5) ** 2) / 3.0)
    base = 0.18
    weekend = 1.12 if weekday >= 5 else 1.0
    return (base + 0.42 * evening + 0.24 * morning) * weekend


def generate(
    fleet: SyntheticFleet,
    *,
    start: datetime,
    hours: int,
    interval_minutes: int = 15,
) -> dict[str, list]:
    """Telemetry-shaped columns, in the same names and units the platform's
    `telemetry` table uses: `power` and `energy` in W and Wh, `stateOfCharge` in
    percent, `voltage` in volts. Column names match so the same feature builder
    reads synthetic and platform rows without a translation layer that could
    disagree between them."""
    import numpy as np  # noqa: PLC0415

    steps = int(hours * 60 / interval_minutes)
    if steps <= 0:
        raise ValueError("hours and interval_minutes must produce at least one step")
    step = timedelta(minutes=interval_minutes)
    hours_per_step = interval_minutes / 60.0

    asset_ids: list[int] = []
    timestamps: list[datetime] = []
    powers: list[int] = []
    energies: list[int] = []
    voltages: list[int] = []
    socs: list[Optional[int]] = []

    # Cloud cover is shared across the fleet as a slow AR(1) walk, so sites on the
    # same feeder are correlated — an independent draw per site would make the
    # aggregate far smoother than any real fleet's, and a model trained on it
    # would understate feeder-level variability.
    cloud_rng = _rng(fleet.seed, "cloud")
    cloud = np.empty(steps, dtype=float)
    level = 0.75
    for index in range(steps):
        level = 0.86 * level + 0.14 * float(cloud_rng.uniform(0.25, 1.0))
        cloud[index] = min(1.0, max(0.05, level))

    for asset in fleet.assets:
        rng = _rng(fleet.seed, asset.asset_id, asset.kind)
        noise = rng.normal(0.0, 0.035, steps)
        site_bias = float(rng.uniform(0.85, 1.15))
        soc = float(rng.uniform(35.0, 70.0)) if asset.kind == "battery" else None
        cumulative_wh = 0.0

        for index in range(steps):
            at = start + index * step
            hour = at.hour + at.minute / 60.0

            if asset.kind == "solar":
                fraction = _clear_sky(hour) * float(cloud[index]) * site_bias
                power = max(0.0, asset.capacity_w * fraction * (1.0 + noise[index]))
                cumulative_wh += power * hours_per_step
                soc_value: Optional[int] = None
            elif asset.kind == "meter":
                fraction = _household_shape(hour, at.weekday()) * site_bias
                power = -max(0.0, asset.capacity_w * fraction * (1.0 + noise[index]))
                cumulative_wh += abs(power) * hours_per_step
                soc_value = None
            else:
                # Charge into the solar middle of the day, discharge into the
                # evening peak, and integrate SoC from that same power so the two
                # channels stay physically consistent.
                assert soc is not None
                if 9.0 <= hour < 15.0:
                    command = 0.7 * asset.capacity_w
                elif 17.5 <= hour < 21.5:
                    command = -0.8 * asset.capacity_w
                else:
                    command = 0.0
                command *= 1.0 + noise[index]
                if command > 0 and soc >= 97.0:
                    command = 0.0
                if command < 0 and soc <= 12.0:
                    command = 0.0
                delta_wh = command * hours_per_step
                if asset.storage_wh > 0:
                    soc = min(100.0, max(0.0, soc + 100.0 * delta_wh / asset.storage_wh))
                # A battery charging draws from the site, so its reported power is
                # negative while charging.
                power = -command
                cumulative_wh += abs(power) * hours_per_step
                soc_value = int(round(soc))

            asset_ids.append(asset.asset_id)
            timestamps.append(at)
            powers.append(int(round(power)))
            energies.append(int(round(cumulative_wh)))
            voltages.append(int(round(float(rng.normal(233.0, 1.8)))))
            socs.append(soc_value)

    return {
        "assetId": asset_ids,
        "timestamp": timestamps,
        "power": powers,
        "energy": energies,
        "voltage": voltages,
        "stateOfCharge": socs,
    }


def asset_kinds(fleet: SyntheticFleet) -> dict[int, str]:
    return {asset.asset_id: asset.kind for asset in fleet.assets}


def asset_nodes(fleet: SyntheticFleet) -> dict[int, int]:
    return {asset.asset_id: asset.node_id for asset in fleet.assets}


def asset_capacities(fleet: SyntheticFleet) -> dict[int, int]:
    return {asset.asset_id: asset.capacity_w for asset in fleet.assets}


def provenance(fleet: SyntheticFleet, *, hours: int, interval_minutes: int) -> dict[str, object]:
    """What has to be stored for the dataset to be regenerable."""
    return {
        "generator": GENERATOR_NAME,
        "generator_version": GENERATOR_VERSION,
        "seed": fleet.seed,
        "assets": len(fleet.assets),
        "nodes": len(fleet.node_parents),
        "hours": hours,
        "interval_minutes": interval_minutes,
    }


def iter_asset_ids(fleet: SyntheticFleet) -> Iterable[int]:
    return (asset.asset_id for asset in fleet.assets)
