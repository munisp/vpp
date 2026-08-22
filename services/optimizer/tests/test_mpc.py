"""Rolling-horizon MPC: state carry-over and realised-vs-forecast honesty."""

from __future__ import annotations

import pytest
from factories import battery_asset, request_with, solar_asset

from optimizer.mpc import run_mpc
from optimizer.schemas import MPCRequest, MPCStep, SolveStatus


def _base(horizon: int = 6, **battery):
    return request_with(
        load_w=[2_000] * horizon,
        import_prices=[10.0, 10.0, 60.0, 60.0, 10.0, 10.0][:horizon],
        assets=[battery_asset(capacity_wh=20_000, initial_soc_percent=50.0, **battery)],
    )


def test_each_step_applies_exactly_one_interval():
    result = run_mpc(MPCRequest(base=_base(), steps=4))
    assert result.status is SolveStatus.OPTIMAL
    assert [s.step for s in result.steps] == [0, 1, 2, 3]
    assert [s.horizon_remaining for s in result.steps] == [6, 5, 4, 3]
    assert [s.applied.index for s in result.steps] == [0, 1, 2, 3]


def test_soc_is_carried_forward_between_steps():
    result = run_mpc(MPCRequest(base=_base(), steps=4))
    assert result.status is SolveStatus.OPTIMAL

    def soc(step):
        return next(
            s.soc_percent for s in step.applied.setpoints if s.asset_id == "batt-1"
        )

    socs = [soc(s) for s in result.steps]
    powers = [
        next(s.power_w for s in step.applied.setpoints if s.asset_id == "batt-1")
        for step in result.steps
    ]
    # Each step must start from the SoC the previous step ended at: the energy
    # moved in step n has to explain the SoC change between steps n-1 and n.
    previous = 50.0
    for power, ending in zip(powers, socs):
        delta_wh = -power * 1.0 / 0.95 if power > 0 else -power * 0.95
        expected = previous + delta_wh / 20_000 * 100
        assert ending == pytest.approx(expected, abs=1e-4), (powers, socs)
        previous = ending


def test_steps_without_realised_data_are_flagged_as_forecast_driven():
    result = run_mpc(MPCRequest(base=_base(), steps=3))
    assert all(step.used_realised_data is False for step in result.steps)
    assert result.diagnostics["realised_steps_supplied"] == 0


def test_realised_data_overrides_the_forecast_and_is_flagged():
    horizon = 4
    base = request_with(
        load_w=[1_000] * horizon,
        import_prices=[10.0] * horizon,
        assets=[solar_asset([0.0] * horizon), battery_asset(initial_soc_percent=50.0)],
    )
    realised = [
        MPCStep(load_w=5_000, generation_w={"pv-1": 0.0}) for _ in range(horizon)
    ]
    forecast_run = run_mpc(MPCRequest(base=base, steps=horizon))
    realised_run = run_mpc(MPCRequest(base=base, steps=horizon, realised=realised))

    assert all(step.used_realised_data for step in realised_run.steps)
    assert realised_run.diagnostics["realised_steps_supplied"] == horizon
    # The measured load is five times the forecast, so the applied plan must
    # actually change rather than replay the forecast schedule.
    assert realised_run.steps[0].applied.grid_import_w > forecast_run.steps[0].applied.grid_import_w
    assert realised_run.realised_cost_cents > forecast_run.realised_cost_cents


def test_partial_realised_data_is_rejected_rather_than_padded():
    with pytest.raises(ValueError, match="realised must cover every step"):
        MPCRequest(base=_base(), steps=4, realised=[MPCStep(load_w=1_000)])


def test_terminal_soc_binds_only_on_the_final_window():
    # A terminal target that is unreachable within one interval would make every
    # early window infeasible if the obligation were applied to each sub-horizon.
    base = _base(horizon=6, terminal_soc_percent=90.0)
    result = run_mpc(MPCRequest(base=base, steps=3))
    assert result.status is SolveStatus.OPTIMAL
    assert len(result.steps) == 3


def test_failed_step_stops_the_run_and_reports_the_status():
    base = request_with(
        load_w=[1_000] * 4,
        import_prices=[10.0] * 4,
        assets=[
            battery_asset(
                capacity_wh=100_000,
                max_charge_w=100,
                initial_soc_percent=20.0,
                terminal_soc_percent=95.0,
            )
        ],
    )
    result = run_mpc(MPCRequest(base=base, steps=4))
    assert result.status is SolveStatus.INFEASIBLE
    assert result.steps[-1].status is SolveStatus.INFEASIBLE
    assert result.steps[-1].applied.setpoints == []
    assert len(result.steps) < 4


def test_steps_cannot_exceed_the_horizon():
    with pytest.raises(ValueError, match="steps exceeds the horizon"):
        MPCRequest(base=_base(horizon=3), steps=4)
