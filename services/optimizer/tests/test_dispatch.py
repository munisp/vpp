"""Tests that assert the MILP actually optimises, not merely that it returns."""

from __future__ import annotations

import pytest
from factories import battery_asset, request_with, solar_asset

from optimizer.dispatch import solve_dispatch
from optimizer.schemas import Objective, SolveStatus


def _battery_power(result, asset_id="batt-1"):
    return [
        next(s.power_w for s in interval.setpoints if s.asset_id == asset_id)
        for interval in result.intervals
    ]


def test_arbitrage_charges_cheap_and_discharges_expensive():
    # Two cheap hours then two expensive ones; a correct optimiser fills the
    # battery early and empties it late. A per-interval greedy rule with a fixed
    # average-price threshold cannot see the second half of the horizon.
    result = solve_dispatch(
        request_with(
            load_w=[1_000] * 4,
            import_prices=[5.0, 5.0, 50.0, 50.0],
            export_prices=[0.0] * 4,
            assets=[battery_asset(initial_soc_percent=10.0)],
        )
    )

    assert result.status is SolveStatus.OPTIMAL
    power = _battery_power(result)
    assert sum(power[:2]) < 0, f"expected net charging in cheap hours, got {power}"
    assert min(power[:2]) < -100, f"expected real charging power, got {power}"
    assert all(p >= -1e-6 for p in power[2:]), f"charged during expensive hours: {power}"
    assert sum(power[2:]) > 0, f"expected discharging in expensive hours, got {power}"
    assert result.intervals[2].grid_import_w < 1.0
    assert result.intervals[3].grid_import_w < 1.0


def test_soc_never_leaves_its_window():
    result = solve_dispatch(
        request_with(
            load_w=[4_000] * 6,
            import_prices=[40.0, 5.0, 40.0, 5.0, 40.0, 5.0],
            assets=[battery_asset(initial_soc_percent=50.0, soc_min_percent=20, soc_max_percent=80)],
        )
    )

    assert result.status is SolveStatus.OPTIMAL
    for interval in result.intervals:
        soc = next(s.soc_percent for s in interval.setpoints if s.asset_id == "batt-1")
        assert soc is not None
        assert 20 - 1e-6 <= soc <= 80 + 1e-6, f"SoC {soc} left the window"


def test_battery_never_charges_and_discharges_at_once():
    result = solve_dispatch(
        request_with(
            load_w=[2_000] * 4,
            import_prices=[10.0, 10.0, 10.0, 10.0],
            # An export price above the import price would otherwise tempt the LP
            # to cycle the battery to manufacture revenue from nothing.
            export_prices=[30.0] * 4,
            assets=[battery_asset()],
            objective=Objective.MAXIMIZE_REVENUE,
        )
    )

    assert result.status is SolveStatus.OPTIMAL
    for interval in result.intervals:
        assert not (interval.grid_import_w > 1 and interval.grid_export_w > 1)


def test_round_trip_losses_make_pointless_cycling_unprofitable():
    # Import and export priced identically: with efficiency losses and a cycle
    # cost, buying to resell always loses money. A model that ignored efficiency
    # would find a free arbitrage here.
    result = solve_dispatch(
        request_with(
            load_w=[0, 0, 0],
            import_prices=[20.0] * 3,
            export_prices=[20.0] * 3,
            assets=[
                battery_asset(
                    initial_soc_percent=50.0,
                    charge_efficiency=0.9,
                    discharge_efficiency=0.9,
                    cycle_cost_cents_per_kwh=0.5,
                )
            ],
            objective=Objective.MAXIMIZE_REVENUE,
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    assert result.totals.imported_wh == pytest.approx(0.0, abs=1.0)


def test_terminal_soc_requirement_is_met():
    result = solve_dispatch(
        request_with(
            load_w=[500] * 4,
            import_prices=[20.0] * 4,
            assets=[battery_asset(initial_soc_percent=20.0, terminal_soc_percent=80.0)],
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    final_soc = next(
        s.soc_percent for s in result.intervals[-1].setpoints if s.asset_id == "batt-1"
    )
    assert final_soc is not None and final_soc >= 80.0 - 1e-6


def test_infeasible_terminal_soc_reports_infeasible_not_a_schedule():
    # 1 kW charger cannot lift a 100 kWh pack by 60% in one hour.
    result = solve_dispatch(
        request_with(
            load_w=[0],
            import_prices=[10.0],
            assets=[
                battery_asset(
                    capacity_wh=100_000,
                    max_charge_w=1_000,
                    max_discharge_w=1_000,
                    initial_soc_percent=20.0,
                    terminal_soc_percent=80.0,
                )
            ],
        )
    )
    assert result.status is SolveStatus.INFEASIBLE
    assert result.intervals == []


def test_import_limit_forces_unserved_load_to_be_reported():
    result = solve_dispatch(
        request_with(
            load_w=[10_000],
            import_prices=[10.0],
            max_import_w=4_000,
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    assert result.intervals[0].grid_import_w <= 4_000 + 1e-6
    # The shortfall is surfaced rather than quietly balanced away.
    assert result.intervals[0].unserved_load_w == pytest.approx(6_000, abs=1.0)
    assert result.totals.unserved_load_cost_cents > 0


def test_self_consumption_prefers_local_use_over_export():
    solar = [5_000, 5_000]
    self_consumption = solve_dispatch(
        request_with(
            load_w=[1_000, 1_000],
            import_prices=[10.0, 10.0],
            export_prices=[30.0, 30.0],
            assets=[solar_asset(solar), battery_asset(initial_soc_percent=20.0)],
            objective=Objective.MAXIMIZE_SELF_CONSUMPTION,
        )
    )
    revenue = solve_dispatch(
        request_with(
            load_w=[1_000, 1_000],
            import_prices=[10.0, 10.0],
            export_prices=[30.0, 30.0],
            assets=[solar_asset(solar), battery_asset(initial_soc_percent=20.0)],
            objective=Objective.MAXIMIZE_REVENUE,
        )
    )
    assert self_consumption.status is SolveStatus.OPTIMAL
    assert revenue.status is SolveStatus.OPTIMAL
    assert self_consumption.totals.exported_wh < revenue.totals.exported_wh


def test_emissions_objective_requires_carbon_intensity():
    with pytest.raises(ValueError, match="grid_emissions_g_per_kwh"):
        request_with(
            load_w=[1_000],
            import_prices=[10.0],
            objective=Objective.MINIMIZE_EMISSIONS,
        )


def test_emissions_objective_shifts_load_to_clean_hours():
    request = request_with(
        load_w=[2_000, 2_000],
        import_prices=[10.0, 10.0],
        emissions_g_per_kwh=[800.0, 100.0],
        assets=[battery_asset(initial_soc_percent=50.0)],
        objective=Objective.MINIMIZE_EMISSIONS,
    )
    result = solve_dispatch(request)
    assert result.status is SolveStatus.OPTIMAL
    # The dirty hour should be served from storage rather than the grid.
    assert result.intervals[0].grid_import_w < result.intervals[1].grid_import_w


def test_balance_grid_tracks_the_requested_setpoint():
    request = request_with(
        load_w=[3_000, 3_000, 3_000],
        import_prices=[10.0] * 3,
        assets=[battery_asset(capacity_wh=40_000, initial_soc_percent=80.0)],
        objective=Objective.BALANCE_GRID,
        grid_target_w=[1_000, 1_000, 1_000],
    )
    result = solve_dispatch(request)
    assert result.status is SolveStatus.OPTIMAL
    for interval in result.intervals:
        net = interval.grid_import_w - interval.grid_export_w
        assert abs(net - 1_000) < 50, f"net {net} strayed from the 1 kW target"


def test_horizon_mismatch_is_rejected():
    with pytest.raises(ValueError, match="horizon"):
        request_with(load_w=[1_000, 1_000], import_prices=[10.0])


def test_curtailment_is_reported_when_generation_cannot_be_used():
    result = solve_dispatch(
        request_with(
            load_w=[0.0],
            import_prices=[10.0],
            export_prices=[0.0],
            assets=[solar_asset([5_000])],
            max_export_w=0,
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    assert result.totals.curtailed_wh == pytest.approx(5_000, abs=1.0)


def test_non_curtailable_generation_with_no_sink_is_infeasible():
    result = solve_dispatch(
        request_with(
            load_w=[0.0],
            import_prices=[10.0],
            assets=[solar_asset([5_000], curtailable=False)],
            max_export_w=0,
        )
    )
    assert result.status is SolveStatus.INFEASIBLE
