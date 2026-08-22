"""Two-stage stochastic dispatch and CVaR risk control."""

from __future__ import annotations

import pytest
from factories import battery_asset, request_with

from optimizer.schemas import Prices, Scenario, SolveStatus, StochasticRequest
from optimizer.stochastic import solve_stochastic


def _base(horizon: int = 4, **kwargs):
    return request_with(
        load_w=[2_000] * horizon,
        import_prices=[20.0] * horizon,
        assets=[battery_asset(capacity_wh=20_000, initial_soc_percent=50.0)],
        **kwargs,
    )


def _scenario(scenario_id: str, probability: float, import_prices: list[float]) -> Scenario:
    return Scenario(
        scenario_id=scenario_id,
        probability=probability,
        prices=Prices(
            import_cents_per_kwh=import_prices,
            export_cents_per_kwh=[0.0] * len(import_prices),
        ),
    )


def test_first_stage_decisions_are_identical_across_scenarios():
    # A small battery cannot cover the load outright, so the cheap and dear
    # scenarios must diverge after the first stage.
    base = request_with(
        load_w=[2_000] * 4,
        import_prices=[20.0] * 4,
        assets=[battery_asset(capacity_wh=4_000, initial_soc_percent=50.0)],
    )
    result = solve_stochastic(
        StochasticRequest(
            base=base,
            first_stage_intervals=2,
            scenarios=[
                _scenario("low", 0.5, [20.0, 5.0, 5.0, 5.0]),
                _scenario("high", 0.5, [20.0, 90.0, 90.0, 90.0]),
            ],
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    assert len(result.first_stage) == 2
    # Reported per-scenario costs must differ: the recourse stage is scenario-specific.
    costs = {o.scenario_id: o.cost_cents for o in result.per_scenario}
    assert costs["low"] != costs["high"]


def test_expected_cost_is_the_probability_weighted_scenario_cost():
    result = solve_stochastic(
        StochasticRequest(
            base=_base(),
            scenarios=[
                _scenario("cheap", 0.7, [5.0] * 4),
                _scenario("dear", 0.3, [80.0] * 4),
            ],
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    weighted = sum(o.probability * o.cost_cents for o in result.per_scenario)
    assert result.expected_cost_cents == pytest.approx(weighted, rel=1e-6)


def test_cvar_is_at_least_the_expected_cost():
    result = solve_stochastic(
        StochasticRequest(
            base=_base(),
            cvar_alpha=0.9,
            cvar_weight=0.5,
            scenarios=[
                _scenario("s1", 0.4, [10.0] * 4),
                _scenario("s2", 0.4, [30.0] * 4),
                _scenario("s3", 0.2, [120.0] * 4),
            ],
        )
    )
    assert result.status is SolveStatus.OPTIMAL
    assert result.cvar_cents >= result.expected_cost_cents - 1e-6


def test_risk_aversion_reduces_the_worst_case_cost():
    scenarios = [
        _scenario("mild", 0.8, [10.0, 10.0, 10.0, 10.0]),
        _scenario("spike", 0.2, [10.0, 10.0, 300.0, 300.0]),
    ]
    neutral = solve_stochastic(
        StochasticRequest(base=_base(), cvar_weight=0.0, scenarios=scenarios)
    )
    averse = solve_stochastic(
        StochasticRequest(
            base=_base(), cvar_weight=1.0, cvar_alpha=0.8, scenarios=scenarios
        )
    )
    assert neutral.status is SolveStatus.OPTIMAL
    assert averse.status is SolveStatus.OPTIMAL

    def worst(result):
        return max(o.cost_cents for o in result.per_scenario)

    assert worst(averse) <= worst(neutral) + 1e-6
    # And it pays for that protection in expectation.
    assert averse.expected_cost_cents >= neutral.expected_cost_cents - 1e-6


def test_probabilities_must_sum_to_one():
    with pytest.raises(ValueError, match="probabilities sum"):
        StochasticRequest(
            base=_base(),
            scenarios=[_scenario("a", 0.4, [10.0] * 4), _scenario("b", 0.4, [10.0] * 4)],
        )


def test_duplicate_scenario_ids_are_rejected():
    with pytest.raises(ValueError, match="unique"):
        StochasticRequest(
            base=_base(),
            scenarios=[_scenario("a", 0.5, [10.0] * 4), _scenario("a", 0.5, [10.0] * 4)],
        )


def test_scenario_series_must_match_the_horizon():
    request = StochasticRequest(
        base=_base(),
        scenarios=[_scenario("a", 1.0, [10.0, 10.0])],
    )
    with pytest.raises(ValueError, match="horizon"):
        solve_stochastic(request)


def test_infeasible_scenario_returns_no_first_stage_plan():
    base = request_with(
        load_w=[10_000] * 2,
        import_prices=[10.0] * 2,
        max_import_w=1_000,
        assets=[
            battery_asset(
                capacity_wh=10_000,
                max_charge_w=100,
                initial_soc_percent=20.0,
                terminal_soc_percent=95.0,
            )
        ],
    )
    result = solve_stochastic(
        StochasticRequest(
            base=base,
            scenarios=[
                Scenario(
                    scenario_id="only",
                    probability=1.0,
                    prices=Prices(
                        import_cents_per_kwh=[10.0, 10.0],
                        export_cents_per_kwh=[0.0, 0.0],
                    ),
                )
            ],
        )
    )
    assert result.status is not SolveStatus.OPTIMAL
    assert result.first_stage == []
    assert result.per_scenario == []
