"""Two-stage stochastic dispatch with CVaR risk control.

One MILP contains every scenario. Decisions in the first
`first_stage_intervals` are forced equal across scenarios (non-anticipativity):
they must be committed before the uncertainty resolves, which is exactly what
makes them safe to send to a device now. Later intervals are recourse and may
differ per scenario.

Risk is controlled with the Rockafellar-Uryasev CVaR formulation:

    CVaR_alpha = eta + 1/(1-alpha) * Σ p_s * z_s ,  z_s >= cost_s - eta,  z_s >= 0

and the objective is a convex combination of expected cost and CVaR.
"""

from __future__ import annotations

import logging

import pulp

from .dispatch import (
    _STATUS_MAP,
    _effective_weights,
    build_site_model,
    extract_plan,
    objective_expression,
)
from .schemas import (
    Prices,
    ScenarioOutcome,
    SolveStatus,
    StochasticRequest,
    StochasticResponse,
)
from .solvers import build_solver, resolve_solver_name

logger = logging.getLogger(__name__)


def solve_stochastic(
    request: StochasticRequest, *, solver_name: str | None = None
) -> StochasticResponse:
    base = request.base
    horizon = base.horizon
    prob = pulp.LpProblem("stochastic_dispatch", pulp.LpMinimize)
    weights = _effective_weights(base)

    models = {}
    costs = {}
    for scenario in request.scenarios:
        prices = scenario.prices or base.prices
        if scenario.prices is not None:
            _validate_prices(scenario.scenario_id, prices, horizon)
        load = scenario.load_w if scenario.load_w is not None else base.site.load_w
        if len(load) != horizon:
            raise ValueError(
                f"scenario {scenario.scenario_id}: load_w has {len(load)} entries, "
                f"horizon is {horizon}"
            )
        model = build_site_model(
            prob,
            base,
            suffix=scenario.scenario_id,
            prices=prices,
            load_w=load,
            generation_w=scenario.generation_w,
        )
        models[scenario.scenario_id] = model
        costs[scenario.scenario_id] = objective_expression(model, base, weights)

    # Non-anticipativity: tie every first-stage decision to the first scenario.
    reference_id = request.scenarios[0].scenario_id
    reference = models[reference_id]
    for scenario in request.scenarios[1:]:
        other = models[scenario.scenario_id]
        for t in range(request.first_stage_intervals):
            prob += (
                reference.imp[t] == other.imp[t],
                f"na_imp_{scenario.scenario_id}_{t}",
            )
            prob += (
                reference.exp[t] == other.exp[t],
                f"na_exp_{scenario.scenario_id}_{t}",
            )
            for aid in reference.charge:
                prob += (
                    reference.charge[aid][t] == other.charge[aid][t],
                    f"na_ch_{scenario.scenario_id}_{aid}_{t}",
                )
                prob += (
                    reference.discharge[aid][t] == other.discharge[aid][t],
                    f"na_dis_{scenario.scenario_id}_{aid}_{t}",
                )
            for aid in reference.shed:
                prob += (
                    reference.shed[aid][t] == other.shed[aid][t],
                    f"na_shed_{scenario.scenario_id}_{aid}_{t}",
                )

    expected = pulp.lpSum(
        scenario.probability * costs[scenario.scenario_id] for scenario in request.scenarios
    )

    eta = pulp.LpVariable("cvar_eta")
    excess = {
        scenario.scenario_id: pulp.LpVariable(f"cvar_z_{scenario.scenario_id}", lowBound=0)
        for scenario in request.scenarios
    }
    for scenario in request.scenarios:
        prob += (
            excess[scenario.scenario_id] >= costs[scenario.scenario_id] - eta,
            f"cvar_excess_{scenario.scenario_id}",
        )
    cvar = eta + pulp.lpSum(
        scenario.probability * excess[scenario.scenario_id] / (1.0 - request.cvar_alpha)
        for scenario in request.scenarios
    )

    prob += (1.0 - request.cvar_weight) * expected + request.cvar_weight * cvar

    solver = build_solver(
        time_limit_seconds=base.solver_time_limit_seconds,
        relative_gap=base.solver_relative_gap,
        requested=solver_name,
    )
    raw_status = prob.solve(solver)
    status = _STATUS_MAP.get(raw_status, SolveStatus.NOT_SOLVED)
    name = resolve_solver_name(solver_name)

    if status is not SolveStatus.OPTIMAL:
        logger.warning("stochastic solve ended with status %s", status.value)
        return StochasticResponse(
            status=status,
            solver=name,
            interval_minutes=base.interval_minutes,
            horizon=horizon,
            expected_cost_cents=0.0,
            cvar_cents=0.0,
            cvar_alpha=request.cvar_alpha,
            first_stage=[],
            per_scenario=[],
            diagnostics={
                "pulp_status": pulp.LpStatus[raw_status],
                "scenarios": len(request.scenarios),
                "variables": len(prob.variables()),
            },
        )

    outcomes = [
        ScenarioOutcome(
            scenario_id=scenario.scenario_id,
            probability=scenario.probability,
            cost_cents=float(pulp.value(costs[scenario.scenario_id]) or 0.0),
        )
        for scenario in request.scenarios
    ]

    first_stage = extract_plan(reference, base)[: request.first_stage_intervals]

    return StochasticResponse(
        status=status,
        solver=name,
        interval_minutes=base.interval_minutes,
        horizon=horizon,
        expected_cost_cents=float(pulp.value(expected) or 0.0),
        cvar_cents=float(pulp.value(cvar) or 0.0),
        cvar_alpha=request.cvar_alpha,
        first_stage=first_stage,
        per_scenario=outcomes,
        diagnostics={
            "pulp_status": pulp.LpStatus[raw_status],
            "scenarios": len(request.scenarios),
            "first_stage_intervals": request.first_stage_intervals,
            "cvar_weight": request.cvar_weight,
            "variables": len(prob.variables()),
        },
    )


def _validate_prices(scenario_id: str, prices: Prices, horizon: int) -> None:
    for field_name, series in (
        ("import_cents_per_kwh", prices.import_cents_per_kwh),
        ("export_cents_per_kwh", prices.export_cents_per_kwh),
    ):
        if len(series) != horizon:
            raise ValueError(
                f"scenario {scenario_id}: prices.{field_name} has {len(series)} "
                f"entries, horizon is {horizon}"
            )
    if (
        prices.grid_emissions_g_per_kwh is not None
        and len(prices.grid_emissions_g_per_kwh) != horizon
    ):
        raise ValueError(
            f"scenario {scenario_id}: prices.grid_emissions_g_per_kwh length "
            f"does not match the horizon"
        )
