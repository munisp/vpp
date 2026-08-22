"""Reproducible benchmark: MILP dispatch versus the rule-based heuristic.

The heuristic mirrors the rule the TypeScript engine used before this service
existed (charge when the price is below 80% of the horizon average, discharge
above 120%, per interval, per asset). Both engines are scored with the same cost
accounting so the comparison is meaningful, and the instances are generated from
a fixed seed so numbers are reproducible across runs and machines.

    python -m benchmarks.run           # full suite
    python -m benchmarks.run --quick   # smaller horizons, used in CI
"""

from __future__ import annotations

import argparse
import math
import random
import time
from dataclasses import dataclass

from optimizer.dispatch import solve_dispatch
from optimizer.schemas import (
    Asset,
    BatterySpec,
    DispatchRequest,
    GenerationSpec,
    Objective,
    Prices,
    Site,
    SolveStatus,
)

SEED = 20260822
UNSERVED_COST_CENTS_PER_KWH = 1000.0


@dataclass(frozen=True)
class Instance:
    name: str
    request: DispatchRequest


def _price_curve(rng: random.Random, horizon: int) -> list[float]:
    # Diurnal shape plus noise: cheap overnight, peak in the evening.
    curve = []
    for t in range(horizon):
        hour = t % 24
        base = 18.0 + 22.0 * math.sin(math.pi * max(0.0, (hour - 6) / 18.0))
        curve.append(round(max(2.0, base + rng.uniform(-4.0, 4.0)), 3))
    return curve


def _load_curve(rng: random.Random, horizon: int, peak_w: float) -> list[float]:
    curve = []
    for t in range(horizon):
        hour = t % 24
        shape = 0.45 + 0.55 * math.sin(math.pi * max(0.0, (hour - 5) / 19.0))
        curve.append(round(peak_w * shape * rng.uniform(0.9, 1.1), 1))
    return curve


def _solar_curve(horizon: int, peak_w: float) -> list[float]:
    return [
        round(peak_w * max(0.0, math.sin(math.pi * ((t % 24) - 6) / 12.0)), 1)
        for t in range(horizon)
    ]


def build_instances(quick: bool) -> list[Instance]:
    rng = random.Random(SEED)
    horizons = [24, 48] if quick else [24, 48, 96]
    instances: list[Instance] = []

    for horizon in horizons:
        for battery_count in (1, 3):
            prices = _price_curve(rng, horizon)
            load = _load_curve(rng, horizon, peak_w=8_000 * battery_count)
            assets: list[Asset] = [
                Asset(
                    asset_id=f"batt-{i}",
                    asset_type="battery",
                    battery=BatterySpec(
                        capacity_wh=20_000,
                        max_charge_w=5_000,
                        max_discharge_w=5_000,
                        initial_soc_percent=50.0,
                        cycle_cost_cents_per_kwh=1.0,
                    ),
                )
                for i in range(battery_count)
            ]
            assets.append(
                Asset(
                    asset_id="pv-0",
                    asset_type="generation",
                    generation=GenerationSpec(
                        available_w=_solar_curve(horizon, peak_w=6_000), curtailable=True
                    ),
                )
            )
            request = DispatchRequest(
                interval_minutes=60,
                objective=Objective.MINIMIZE_COST,
                site=Site(
                    site_id=f"bench-{horizon}h-{battery_count}b",
                    assets=assets,
                    load_w=load,
                    max_import_w=30_000,
                    max_export_w=30_000,
                    unserved_load_cost_cents_per_kwh=UNSERVED_COST_CENTS_PER_KWH,
                ),
                prices=Prices(
                    import_cents_per_kwh=prices,
                    export_cents_per_kwh=[round(p * 0.8, 3) for p in prices],
                ),
                solver_time_limit_seconds=60.0,
            )
            instances.append(
                Instance(name=f"{horizon}h/{battery_count}batt/pv", request=request)
            )
    return instances


def heuristic_cost_cents(request: DispatchRequest) -> float:
    """Score the pre-MILP rule: per-interval thresholds against the mean price."""
    prices = request.prices.import_cents_per_kwh
    export_prices = request.prices.export_cents_per_kwh
    average = sum(prices) / len(prices)
    dt = request.interval_hours

    energy_kwh: dict[str, float] = {}
    specs: dict[str, BatterySpec] = {}
    for asset in request.site.assets:
        if asset.battery is not None:
            specs[asset.asset_id] = asset.battery
            energy_kwh[asset.asset_id] = (
                asset.battery.capacity_wh * asset.battery.initial_soc_percent / 100.0 / 1000.0
            )

    generation = [
        asset.generation.available_w
        for asset in request.site.assets
        if asset.generation is not None
    ]

    total = 0.0
    for t, price in enumerate(prices):
        pv_kw = sum(series[t] for series in generation) / 1000.0
        load_kw = request.site.load_w[t] / 1000.0
        battery_kw = 0.0

        for asset_id, spec in specs.items():
            capacity_kwh = spec.capacity_wh / 1000.0
            floor_kwh = capacity_kwh * spec.soc_min_percent / 100.0
            ceiling_kwh = capacity_kwh * spec.soc_max_percent / 100.0

            if price > average * 1.2:
                available_kwh = max(0.0, energy_kwh[asset_id] - floor_kwh)
                discharge_kw = min(
                    spec.max_discharge_w / 1000.0,
                    available_kwh * spec.discharge_efficiency / dt,
                )
                energy_kwh[asset_id] -= discharge_kw * dt / spec.discharge_efficiency
                battery_kw += discharge_kw
                total += discharge_kw * dt * spec.cycle_cost_cents_per_kwh
            elif price < average * 0.8:
                headroom_kwh = max(0.0, ceiling_kwh - energy_kwh[asset_id])
                charge_kw = min(
                    spec.max_charge_w / 1000.0,
                    headroom_kwh / spec.charge_efficiency / dt,
                )
                energy_kwh[asset_id] += charge_kw * dt * spec.charge_efficiency
                battery_kw -= charge_kw
                total += charge_kw * dt * spec.cycle_cost_cents_per_kwh

        net_kw = load_kw - pv_kw - battery_kw
        if net_kw >= 0:
            import_kw = min(net_kw, request.site.max_import_w / 1000.0)
            unserved_kw = net_kw - import_kw
            total += import_kw * dt * price
            total += unserved_kw * dt * request.site.unserved_load_cost_cents_per_kwh
        else:
            export_kw = min(-net_kw, request.site.max_export_w / 1000.0)
            total -= export_kw * dt * export_prices[t]

    return total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quick", action="store_true", help="smaller suite, used in CI")
    args = parser.parse_args()

    instances = build_instances(quick=args.quick)
    print(f"seed={SEED} instances={len(instances)}")
    header = f"{'instance':<22} {'solver_ms':>10} {'milp_cents':>12} {'heuristic_cents':>16} {'saving':>9}"
    print(header)
    print("-" * len(header))

    failures = 0
    for instance in instances:
        started = time.perf_counter()
        result = solve_dispatch(instance.request)
        elapsed_ms = (time.perf_counter() - started) * 1000.0

        if result.status is not SolveStatus.OPTIMAL:
            print(f"{instance.name:<22} {elapsed_ms:>10.0f} {'-':>12} {'-':>16}  {result.status.value}")
            failures += 1
            continue

        milp = result.totals.objective_value_cents
        heuristic = heuristic_cost_cents(instance.request)
        saving = (heuristic - milp) / abs(heuristic) * 100.0 if heuristic else 0.0
        print(
            f"{instance.name:<22} {elapsed_ms:>10.0f} {milp:>12.1f} {heuristic:>16.1f} {saving:>8.1f}%"
        )
        if milp > heuristic + 1e-6:
            print(f"  REGRESSION: the MILP is worse than the heuristic on {instance.name}")
            failures += 1

    if failures:
        print(f"\n{failures} benchmark instance(s) failed")
        return 1
    print("\nall instances solved to optimality and beat the heuristic")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
