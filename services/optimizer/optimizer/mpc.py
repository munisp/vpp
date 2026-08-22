"""Rolling-horizon model predictive control.

Each control step re-solves the full remaining horizon, applies only the first
interval, advances the battery state with the *realised* data for that interval
and repeats. Realised data that the caller did not supply is not invented: the
step falls back to the forecast and is flagged `used_realised_data: false`.
"""

from __future__ import annotations

import logging

from .dispatch import solve_dispatch
from .schemas import (
    W_PER_KW,
    DispatchRequest,
    IntervalPlan,
    MPCAppliedStep,
    MPCRequest,
    MPCResponse,
    MPCStep,
    Prices,
    SolveStatus,
)
from .solvers import resolve_solver_name

logger = logging.getLogger(__name__)


def _slice_request(base: DispatchRequest, start: int) -> DispatchRequest:
    """Return the request restricted to intervals [start, horizon)."""
    request = base.model_copy(deep=True)
    request.site.load_w = base.site.load_w[start:]
    request.prices = Prices(
        import_cents_per_kwh=base.prices.import_cents_per_kwh[start:],
        export_cents_per_kwh=base.prices.export_cents_per_kwh[start:],
        grid_emissions_g_per_kwh=(
            base.prices.grid_emissions_g_per_kwh[start:]
            if base.prices.grid_emissions_g_per_kwh is not None
            else None
        ),
    )
    if base.grid_target_w is not None:
        request.grid_target_w = base.grid_target_w[start:]
    for asset, base_asset in zip(request.site.assets, base.site.assets):
        if asset.generation is not None and base_asset.generation is not None:
            asset.generation.available_w = base_asset.generation.available_w[start:]
        if asset.flexible_load is not None and base_asset.flexible_load is not None:
            asset.flexible_load.baseline_w = base_asset.flexible_load.baseline_w[start:]
    return request


def _apply_realisation(request: DispatchRequest, realised: MPCStep) -> None:
    """Overwrite the first interval of `request` with measured values."""
    if realised.load_w is not None:
        request.site.load_w[0] = realised.load_w
    if realised.import_cents_per_kwh is not None:
        request.prices.import_cents_per_kwh[0] = realised.import_cents_per_kwh
    if realised.export_cents_per_kwh is not None:
        request.prices.export_cents_per_kwh[0] = realised.export_cents_per_kwh
    if (
        realised.grid_emissions_g_per_kwh is not None
        and request.prices.grid_emissions_g_per_kwh is not None
    ):
        request.prices.grid_emissions_g_per_kwh[0] = realised.grid_emissions_g_per_kwh
    for asset in request.site.assets:
        if asset.generation is not None and asset.asset_id in realised.generation_w:
            asset.generation.available_w[0] = realised.generation_w[asset.asset_id]


def run_mpc(request: MPCRequest, *, solver_name: str | None = None) -> MPCResponse:
    base = request.base
    dt = base.interval_hours
    steps: list[MPCAppliedStep] = []
    realised_cost = 0.0
    # SoC carried forward between control steps, in percent.
    soc_state: dict[str, float] = {
        asset.asset_id: asset.battery.initial_soc_percent
        for asset in base.site.assets
        if asset.battery is not None
    }
    overall = SolveStatus.OPTIMAL

    for step in range(request.steps):
        sub = _slice_request(base, step)
        for asset in sub.site.assets:
            if asset.battery is not None:
                asset.battery.initial_soc_percent = soc_state[asset.asset_id]
            # A terminal-SoC obligation applies to the true end of the horizon,
            # so it must only bind on the last window.
            if asset.battery is not None and step + sub.horizon < base.horizon:
                asset.battery.terminal_soc_percent = None

        used_realised = step < len(request.realised)
        if used_realised:
            _apply_realisation(sub, request.realised[step])

        result = solve_dispatch(sub, solver_name=solver_name)
        if result.status is not SolveStatus.OPTIMAL:
            logger.warning("MPC step %s ended with status %s", step, result.status.value)
            steps.append(
                MPCAppliedStep(
                    step=step,
                    status=result.status,
                    used_realised_data=used_realised,
                    applied=_empty_plan(step, base.interval_minutes),
                    horizon_remaining=sub.horizon,
                )
            )
            overall = result.status
            break

        applied = result.intervals[0]
        applied.index = step
        applied.offset_minutes = step * base.interval_minutes
        steps.append(
            MPCAppliedStep(
                step=step,
                status=result.status,
                used_realised_data=used_realised,
                applied=applied,
                horizon_remaining=sub.horizon,
            )
        )

        realised_cost += (
            applied.grid_import_w / W_PER_KW * sub.prices.import_cents_per_kwh[0] * dt
            - applied.grid_export_w / W_PER_KW * sub.prices.export_cents_per_kwh[0] * dt
        )

        for setpoint in applied.setpoints:
            if setpoint.asset_id in soc_state and setpoint.soc_percent is not None:
                soc_state[setpoint.asset_id] = setpoint.soc_percent

    return MPCResponse(
        status=overall,
        solver=resolve_solver_name(solver_name),
        interval_minutes=base.interval_minutes,
        steps=steps,
        realised_cost_cents=realised_cost,
        diagnostics={
            "steps_completed": len(steps),
            "steps_requested": request.steps,
            "realised_steps_supplied": len(request.realised),
        },
    )


def _empty_plan(index: int, interval_minutes: int) -> IntervalPlan:
    return IntervalPlan(
        index=index,
        offset_minutes=index * interval_minutes,
        grid_import_w=0.0,
        grid_export_w=0.0,
        unserved_load_w=0.0,
        setpoints=[],
    )
