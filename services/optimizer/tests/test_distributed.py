"""Multi-site coordination under a shared connection limit."""

from __future__ import annotations

import pytest
from factories import battery_asset, request_with

from optimizer.distributed import coordinate
from optimizer.schemas import CoordinatedSite, CoordinationRequest, SolveStatus


def _site(
    site_id: str,
    load_w: list[float],
    *,
    with_battery: bool = True,
    import_price: float = 20.0,
    cycle_cost_cents_per_kwh: float = 0.0,
    **kwargs,
):
    request = request_with(
        load_w=load_w,
        import_prices=[import_price] * len(load_w),
        assets=[
            battery_asset(
                f"{site_id}-batt",
                capacity_wh=20_000,
                initial_soc_percent=80.0,
                cycle_cost_cents_per_kwh=cycle_cost_cents_per_kwh,
            )
        ]
        if with_battery
        else [],
        **kwargs,
    )
    request.site.site_id = site_id
    return CoordinatedSite(request=request)


def _aggregate_import(result, index: int) -> float:
    return sum(
        interval.grid_import_w
        for site in result.sites
        for interval in site.intervals
        if interval.index == index
    )


def test_unconstrained_shared_limit_converges_immediately():
    result = coordinate(
        CoordinationRequest(
            sites=[_site("a", [2_000, 2_000]), _site("b", [2_000, 2_000])],
            shared_import_limit_w=[100_000, 100_000],
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    assert result.converged is True
    assert result.iterations == 1
    assert result.max_violation_w == 0.0


def test_binding_shared_limit_is_respected_in_the_returned_plan():
    # Cheap energy and a real cycle cost mean each site prefers to import its
    # whole 6 kW load and leave the battery alone: 12 kW aggregate against a
    # 9 kW shared limit. Only the coordination price makes them discharge.
    sites = [
        _site("a", [6_000] * 3, import_price=2.0, cycle_cost_cents_per_kwh=6.0),
        _site("b", [6_000] * 3, import_price=2.0, cycle_cost_cents_per_kwh=6.0),
    ]
    result = coordinate(
        CoordinationRequest(
            sites=sites,
            shared_import_limit_w=[9_000] * 3,
            max_iterations=100,
            tolerance_w=50.0,
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    assert result.converged is True
    for index in range(3):
        assert _aggregate_import(result, index) <= 9_000 + 50.0
    assert max(result.shadow_prices_cents_per_kwh) > 0


def test_non_convergence_is_reported_instead_of_a_breaching_plan():
    # Two sites with no storage and inelastic load cannot fit under a 1 kW cap;
    # the dual iteration cannot fix that, and must say so.
    result = coordinate(
        CoordinationRequest(
            sites=[
                _site("a", [8_000], with_battery=False),
                _site("b", [8_000], with_battery=False),
            ],
            shared_import_limit_w=[1_000],
            max_iterations=5,
            tolerance_w=10.0,
        )
    )
    assert result.status is SolveStatus.NOT_CONVERGED
    assert result.converged is False
    assert result.max_violation_w > 0
    assert "reason" in result.diagnostics


def test_failed_subproblem_aborts_coordination():
    bad = _site("bad", [1_000], with_battery=False)
    bad.request.site.assets = []
    bad.request.site.max_import_w = 0
    bad.request.site.unserved_load_cost_cents_per_kwh = 0.0
    # Make the site genuinely infeasible rather than merely expensive.
    bad.request.site.load_w = [1_000]
    bad.request.grid_target_w = None
    good = _site("good", [1_000])
    request = CoordinationRequest(
        sites=[bad, good], shared_import_limit_w=[100_000], max_iterations=3
    )
    bad.request.site.assets = [
        battery_asset("bad-batt", capacity_wh=100_000, max_charge_w=100, initial_soc_percent=20.0, terminal_soc_percent=95.0)
    ]
    result = coordinate(request)
    assert result.status is SolveStatus.INFEASIBLE
    assert result.converged is False
    assert result.diagnostics["failed_site"] == "bad"


def test_sites_must_share_one_horizon():
    with pytest.raises(ValueError, match="one horizon"):
        CoordinationRequest(
            sites=[_site("a", [1_000, 1_000]), _site("b", [1_000])],
            shared_import_limit_w=[1_000, 1_000],
        )


def test_shared_limit_length_must_match_the_horizon():
    with pytest.raises(ValueError, match="shared_import_limit_w"):
        CoordinationRequest(
            sites=[_site("a", [1_000, 1_000])], shared_import_limit_w=[1_000]
        )


def test_duplicate_site_ids_are_rejected():
    with pytest.raises(ValueError, match="site_id"):
        CoordinationRequest(
            sites=[_site("a", [1_000]), _site("a", [1_000])],
            shared_import_limit_w=[1_000],
        )
