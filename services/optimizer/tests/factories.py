"""Small request builders shared by the tests."""

from __future__ import annotations

from optimizer.schemas import (
    Asset,
    BatterySpec,
    DispatchRequest,
    GenerationSpec,
    Objective,
    Prices,
    Site,
)


def battery_asset(
    asset_id: str = "batt-1",
    *,
    capacity_wh: float = 10_000,
    max_charge_w: float = 5_000,
    max_discharge_w: float = 5_000,
    initial_soc_percent: float = 50.0,
    **kwargs,
) -> Asset:
    return Asset(
        asset_id=asset_id,
        asset_type="battery",
        battery=BatterySpec(
            capacity_wh=capacity_wh,
            max_charge_w=max_charge_w,
            max_discharge_w=max_discharge_w,
            initial_soc_percent=initial_soc_percent,
            **kwargs,
        ),
    )


def solar_asset(available_w: list[float], asset_id: str = "pv-1", curtailable: bool = True) -> Asset:
    return Asset(
        asset_id=asset_id,
        asset_type="generation",
        generation=GenerationSpec(available_w=available_w, curtailable=curtailable),
    )


def request_with(
    *,
    load_w: list[float],
    import_prices: list[float],
    export_prices: list[float] | None = None,
    emissions_g_per_kwh: list[float] | None = None,
    assets: list[Asset] | None = None,
    objective: Objective = Objective.MINIMIZE_COST,
    max_import_w: float = 20_000,
    max_export_w: float = 20_000,
    interval_minutes: int = 60,
    **kwargs,
) -> DispatchRequest:
    horizon = len(load_w)
    return DispatchRequest(
        interval_minutes=interval_minutes,
        objective=objective,
        site=Site(
            site_id="site-1",
            assets=assets or [],
            load_w=load_w,
            max_import_w=max_import_w,
            max_export_w=max_export_w,
        ),
        prices=Prices(
            import_cents_per_kwh=import_prices,
            export_cents_per_kwh=export_prices or [0.0] * horizon,
            grid_emissions_g_per_kwh=emissions_g_per_kwh,
        ),
        **kwargs,
    )
