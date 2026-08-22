"""Mixed-integer linear dispatch optimisation.

The model is a standard multi-period DER dispatch formulation:

    balance(t):  Σ discharge + Σ generation + import
                 == load - shed + Σ charge + export + unserved

with battery state-of-charge dynamics carrying energy between intervals
(charge and discharge efficiencies applied separately, so a round trip loses
energy), binaries preventing simultaneous charge/discharge and simultaneous
import/export, and a linear objective in cents.

Everything the caller does not supply is a hard error rather than an assumed
default — see `schemas`. In particular there is no assumed price curve, no
assumed carbon intensity and no assumed battery duration.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import pulp

from .schemas import (
    W_PER_KW,
    AssetSetpoint,
    DispatchRequest,
    DispatchResponse,
    DispatchTotals,
    IntervalPlan,
    Objective,
    ObjectiveWeights,
    Prices,
    SolveStatus,
)
from .solvers import build_solver, resolve_solver_name

logger = logging.getLogger(__name__)

_STATUS_MAP = {
    pulp.LpStatusOptimal: SolveStatus.OPTIMAL,
    pulp.LpStatusInfeasible: SolveStatus.INFEASIBLE,
    pulp.LpStatusUnbounded: SolveStatus.UNBOUNDED,
    pulp.LpStatusNotSolved: SolveStatus.NOT_SOLVED,
    pulp.LpStatusUndefined: SolveStatus.NOT_SOLVED,
}

# Default objective weights per objective. Cost and revenue are always priced
# at face value; the others add the term that gives the objective its name.
_DEFAULT_WEIGHTS: dict[Objective, ObjectiveWeights] = {
    Objective.MINIMIZE_COST: ObjectiveWeights(),
    Objective.MAXIMIZE_REVENUE: ObjectiveWeights(),
    Objective.MINIMIZE_EMISSIONS: ObjectiveWeights(emissions_cents_per_kg=1000.0),
    # Import is already penalised through cost; the export penalty is what
    # pushes generation into local load instead of onto the grid.
    Objective.MAXIMIZE_SELF_CONSUMPTION: ObjectiveWeights(export_penalty_cents_per_kwh=100.0),
    Objective.BALANCE_GRID: ObjectiveWeights(grid_deviation_cents_per_kwh=100.0),
}


@dataclass
class SiteModel:
    """LP variables and cost expressions for one site over the horizon."""

    horizon: int
    interval_hours: float
    imp: list[pulp.LpVariable]
    exp: list[pulp.LpVariable]
    unserved: list[pulp.LpVariable]
    deviation: list[pulp.LpVariable] = field(default_factory=list)
    charge: dict[str, list[pulp.LpVariable]] = field(default_factory=dict)
    discharge: dict[str, list[pulp.LpVariable]] = field(default_factory=dict)
    energy: dict[str, list[pulp.LpVariable]] = field(default_factory=dict)
    generation: dict[str, list[pulp.LpVariable]] = field(default_factory=dict)
    available: dict[str, list[float]] = field(default_factory=dict)
    shed: dict[str, list[pulp.LpVariable]] = field(default_factory=dict)
    battery_specs: dict[str, object] = field(default_factory=dict)

    import_cost: pulp.LpAffineExpression | None = None
    export_revenue: pulp.LpAffineExpression | None = None
    cycle_cost: pulp.LpAffineExpression | None = None
    unserved_cost: pulp.LpAffineExpression | None = None
    shed_cost: pulp.LpAffineExpression | None = None
    emissions_g: pulp.LpAffineExpression | None = None
    deviation_kwh: pulp.LpAffineExpression | None = None

    def net_import_kw(self, t: int) -> pulp.LpAffineExpression:
        return self.imp[t] - self.exp[t]


def _effective_weights(request: DispatchRequest) -> ObjectiveWeights:
    base = _DEFAULT_WEIGHTS[request.objective]
    if request.weights is None:
        return base
    override = request.weights.model_dump(exclude_unset=True)
    return base.model_copy(update=override)


def build_site_model(
    prob: pulp.LpProblem,
    request: DispatchRequest,
    *,
    suffix: str = "",
    prices: Prices | None = None,
    load_w: list[float] | None = None,
    generation_w: dict[str, list[float]] | None = None,
) -> SiteModel:
    """Add one site's variables, constraints and cost expressions to `prob`.

    `prices`, `load_w` and `generation_w` override the request's own series,
    which is how the stochastic model instantiates the same site under
    different realisations.
    """
    site = request.site
    horizon = request.horizon
    dt = request.interval_hours
    prices = prices or request.prices
    load = load_w if load_w is not None else site.load_w
    gen_override = generation_w or {}
    tag = f"_{suffix}" if suffix else ""

    max_import_kw = site.max_import_w / W_PER_KW
    max_export_kw = site.max_export_w / W_PER_KW

    imp = [
        pulp.LpVariable(f"imp{tag}_{t}", lowBound=0, upBound=max_import_kw)
        for t in range(horizon)
    ]
    exp = [
        pulp.LpVariable(f"exp{tag}_{t}", lowBound=0, upBound=max_export_kw)
        for t in range(horizon)
    ]
    unserved = [
        pulp.LpVariable(f"unserved{tag}_{t}", lowBound=0, upBound=max(0.0, load[t]) / W_PER_KW)
        for t in range(horizon)
    ]

    model = SiteModel(
        horizon=horizon,
        interval_hours=dt,
        imp=imp,
        exp=exp,
        unserved=unserved,
    )

    # Simultaneous import and export is physically meaningless at one meter and
    # would otherwise let the LP manufacture revenue from a price spread.
    if max_import_kw > 0 and max_export_kw > 0:
        for t in range(horizon):
            direction = pulp.LpVariable(f"gdir{tag}_{t}", cat=pulp.LpBinary)
            prob += imp[t] <= max_import_kw * direction, f"imp_excl{tag}_{t}"
            prob += exp[t] <= max_export_kw * (1 - direction), f"exp_excl{tag}_{t}"

    for asset in site.assets:
        aid = asset.asset_id
        if asset.asset_type == "battery":
            spec = asset.battery
            assert spec is not None
            model.battery_specs[aid] = spec
            cap_kwh = spec.capacity_wh / W_PER_KW
            ch_max = spec.max_charge_w / W_PER_KW
            dis_max = spec.max_discharge_w / W_PER_KW
            e_min = cap_kwh * spec.soc_min_percent / 100.0
            e_max = cap_kwh * spec.soc_max_percent / 100.0
            e_init = cap_kwh * spec.initial_soc_percent / 100.0

            ch = [
                pulp.LpVariable(f"ch{tag}_{aid}_{t}", lowBound=0, upBound=ch_max)
                for t in range(horizon)
            ]
            dis = [
                pulp.LpVariable(f"dis{tag}_{aid}_{t}", lowBound=0, upBound=dis_max)
                for t in range(horizon)
            ]
            energy = [
                pulp.LpVariable(f"soc{tag}_{aid}_{t}", lowBound=e_min, upBound=e_max)
                for t in range(horizon)
            ]

            for t in range(horizon):
                mode = pulp.LpVariable(f"bmode{tag}_{aid}_{t}", cat=pulp.LpBinary)
                prob += ch[t] <= ch_max * mode, f"ch_excl{tag}_{aid}_{t}"
                prob += dis[t] <= dis_max * (1 - mode), f"dis_excl{tag}_{aid}_{t}"

                previous = e_init if t == 0 else energy[t - 1]
                prob += (
                    energy[t]
                    == previous
                    + dt
                    * (
                        ch[t] * spec.charge_efficiency
                        - dis[t] * (1.0 / spec.discharge_efficiency)
                    ),
                    f"soc_balance{tag}_{aid}_{t}",
                )

            if spec.terminal_soc_percent is not None:
                target = cap_kwh * spec.terminal_soc_percent / 100.0
                prob += energy[horizon - 1] >= target, f"soc_terminal{tag}_{aid}"

            model.charge[aid] = ch
            model.discharge[aid] = dis
            model.energy[aid] = energy

        elif asset.asset_type == "generation":
            spec = asset.generation
            assert spec is not None
            available = gen_override.get(aid, spec.available_w)
            if len(available) != horizon:
                raise ValueError(
                    f"asset {aid}: generation override has {len(available)} entries, "
                    f"horizon is {horizon}"
                )
            avail_kw = [max(0.0, v) / W_PER_KW for v in available]
            if spec.curtailable:
                gen = [
                    pulp.LpVariable(f"gen{tag}_{aid}_{t}", lowBound=0, upBound=avail_kw[t])
                    for t in range(horizon)
                ]
            else:
                # Fixed injection: bounds pinned to the forecast.
                gen = [
                    pulp.LpVariable(
                        f"gen{tag}_{aid}_{t}", lowBound=avail_kw[t], upBound=avail_kw[t]
                    )
                    for t in range(horizon)
                ]
            model.generation[aid] = gen
            model.available[aid] = avail_kw

        else:  # flexible_load
            spec = asset.flexible_load
            assert spec is not None
            shed = [
                pulp.LpVariable(
                    f"shed{tag}_{aid}_{t}",
                    lowBound=0,
                    upBound=max(0.0, spec.baseline_w[t]) * spec.sheddable_fraction / W_PER_KW,
                )
                for t in range(horizon)
            ]
            model.shed[aid] = shed

    # Power balance, including flexible load baselines on the demand side.
    for t in range(horizon):
        supply = imp[t] + unserved[t]
        supply += pulp.lpSum(model.discharge[a][t] for a in model.discharge)
        supply += pulp.lpSum(model.generation[a][t] for a in model.generation)

        demand = exp[t] + load[t] / W_PER_KW
        demand += pulp.lpSum(model.charge[a][t] for a in model.charge)
        for asset in site.assets:
            if asset.asset_type == "flexible_load":
                spec = asset.flexible_load
                assert spec is not None
                demand += spec.baseline_w[t] / W_PER_KW - model.shed[asset.asset_id][t]

        prob += supply == demand, f"balance{tag}_{t}"

    # Cost expressions, all in cents.
    model.import_cost = pulp.lpSum(
        imp[t] * prices.import_cents_per_kwh[t] * dt for t in range(horizon)
    )
    model.export_revenue = pulp.lpSum(
        exp[t] * prices.export_cents_per_kwh[t] * dt for t in range(horizon)
    )
    model.cycle_cost = pulp.lpSum(
        (model.charge[aid][t] + model.discharge[aid][t])
        * model.battery_specs[aid].cycle_cost_cents_per_kwh
        * dt
        for aid in model.charge
        for t in range(horizon)
    )
    model.unserved_cost = pulp.lpSum(
        unserved[t] * site.unserved_load_cost_cents_per_kwh * dt for t in range(horizon)
    )
    shed_terms = []
    for asset in site.assets:
        if asset.asset_type == "flexible_load":
            spec = asset.flexible_load
            assert spec is not None
            shed_terms.extend(
                model.shed[asset.asset_id][t] * spec.shed_cost_cents_per_kwh * dt
                for t in range(horizon)
            )
    model.shed_cost = pulp.lpSum(shed_terms)

    if prices.grid_emissions_g_per_kwh is not None:
        ci = prices.grid_emissions_g_per_kwh
        # Exported energy displaces grid generation at the same intensity.
        model.emissions_g = pulp.lpSum(
            (imp[t] - exp[t]) * ci[t] * dt for t in range(horizon)
        )

    if request.grid_target_w is not None:
        deviation = [
            pulp.LpVariable(f"dev{tag}_{t}", lowBound=0) for t in range(horizon)
        ]
        for t in range(horizon):
            target_kw = request.grid_target_w[t] / W_PER_KW
            prob += deviation[t] >= model.net_import_kw(t) - target_kw, f"dev_up{tag}_{t}"
            prob += deviation[t] >= target_kw - model.net_import_kw(t), f"dev_dn{tag}_{t}"
        model.deviation = deviation
        model.deviation_kwh = pulp.lpSum(deviation[t] * dt for t in range(horizon))

    return model


def objective_expression(
    model: SiteModel, request: DispatchRequest, weights: ObjectiveWeights
) -> pulp.LpAffineExpression:
    """Composite minimisation objective in cents.

    Every objective is expressed as a cost to minimise; `maximize_revenue` is
    the same expression with revenue dominating, which is why it shares the
    formulation rather than flipping the sense of the problem.
    """
    expr = weights.cost * model.import_cost - weights.revenue * model.export_revenue
    expr += model.cycle_cost + model.unserved_cost + model.shed_cost

    if weights.emissions_cents_per_kg and model.emissions_g is not None:
        # grams -> kg, then priced.
        expr += model.emissions_g * (weights.emissions_cents_per_kg / 1000.0)

    if weights.export_penalty_cents_per_kwh:
        expr += pulp.lpSum(
            model.exp[t] * weights.export_penalty_cents_per_kwh * model.interval_hours
            for t in range(model.horizon)
        )

    if weights.grid_deviation_cents_per_kwh and model.deviation_kwh is not None:
        expr += model.deviation_kwh * weights.grid_deviation_cents_per_kwh

    return expr


def _value(var: pulp.LpVariable | pulp.LpAffineExpression | None) -> float:
    if var is None:
        return 0.0
    val = pulp.value(var)
    return 0.0 if val is None else float(val)


def extract_plan(model: SiteModel, request: DispatchRequest) -> list[IntervalPlan]:
    plans: list[IntervalPlan] = []
    for t in range(model.horizon):
        setpoints: list[AssetSetpoint] = []
        for aid in model.charge:
            spec = model.battery_specs[aid]
            cap_kwh = spec.capacity_wh / W_PER_KW
            energy_kwh = _value(model.energy[aid][t])
            setpoints.append(
                AssetSetpoint(
                    asset_id=aid,
                    power_w=(_value(model.discharge[aid][t]) - _value(model.charge[aid][t]))
                    * W_PER_KW,
                    soc_percent=100.0 * energy_kwh / cap_kwh if cap_kwh else None,
                )
            )
        for aid, gen in model.generation.items():
            produced = _value(gen[t])
            setpoints.append(
                AssetSetpoint(
                    asset_id=aid,
                    power_w=produced * W_PER_KW,
                    curtailed_w=max(0.0, model.available[aid][t] - produced) * W_PER_KW,
                )
            )
        for aid, shed in model.shed.items():
            setpoints.append(
                AssetSetpoint(
                    asset_id=aid,
                    power_w=0.0,
                    shed_w=_value(shed[t]) * W_PER_KW,
                )
            )
        plans.append(
            IntervalPlan(
                index=t,
                offset_minutes=t * request.interval_minutes,
                grid_import_w=_value(model.imp[t]) * W_PER_KW,
                grid_export_w=_value(model.exp[t]) * W_PER_KW,
                unserved_load_w=_value(model.unserved[t]) * W_PER_KW,
                setpoints=setpoints,
            )
        )
    return plans


def _totals(model: SiteModel, objective_value: float) -> DispatchTotals:
    dt = model.interval_hours
    curtailed = sum(
        max(0.0, model.available[aid][t] - _value(model.generation[aid][t])) * dt
        for aid in model.generation
        for t in range(model.horizon)
    )
    return DispatchTotals(
        objective_value_cents=objective_value,
        import_cost_cents=_value(model.import_cost),
        export_revenue_cents=_value(model.export_revenue),
        cycle_cost_cents=_value(model.cycle_cost),
        unserved_load_cost_cents=_value(model.unserved_cost),
        shed_cost_cents=_value(model.shed_cost),
        emissions_g=_value(model.emissions_g) if model.emissions_g is not None else None,
        imported_wh=sum(_value(v) for v in model.imp) * dt * W_PER_KW,
        exported_wh=sum(_value(v) for v in model.exp) * dt * W_PER_KW,
        curtailed_wh=curtailed * W_PER_KW,
        unserved_wh=sum(_value(v) for v in model.unserved) * dt * W_PER_KW,
    )


def solve_dispatch(request: DispatchRequest, *, solver_name: str | None = None) -> DispatchResponse:
    """Solve the deterministic dispatch MILP.

    Returns a response whose `status` reflects the solver's own verdict. An
    infeasible or unsolved problem yields empty intervals — never a plausible
    looking schedule.
    """
    prob = pulp.LpProblem("dispatch", pulp.LpMinimize)
    model = build_site_model(prob, request)
    weights = _effective_weights(request)
    prob += objective_expression(model, request, weights)

    solver = build_solver(
        time_limit_seconds=request.solver_time_limit_seconds,
        relative_gap=request.solver_relative_gap,
        requested=solver_name,
    )
    raw_status = prob.solve(solver)
    status = _STATUS_MAP.get(raw_status, SolveStatus.NOT_SOLVED)
    name = resolve_solver_name(solver_name)

    if status is not SolveStatus.OPTIMAL:
        logger.warning(
            "dispatch solve for site %s ended with status %s",
            request.site.site_id,
            status.value,
        )
        return DispatchResponse(
            status=status,
            solver=name,
            objective=request.objective,
            interval_minutes=request.interval_minutes,
            horizon=request.horizon,
            totals=DispatchTotals(
                objective_value_cents=0.0,
                import_cost_cents=0.0,
                export_revenue_cents=0.0,
                cycle_cost_cents=0.0,
                unserved_load_cost_cents=0.0,
                shed_cost_cents=0.0,
                emissions_g=None,
                imported_wh=0.0,
                exported_wh=0.0,
                curtailed_wh=0.0,
                unserved_wh=0.0,
            ),
            intervals=[],
            diagnostics={
                "pulp_status": pulp.LpStatus[raw_status],
                "variables": len(prob.variables()),
                "constraints": len(prob.constraints),
            },
        )

    objective_value = _value(prob.objective)
    return DispatchResponse(
        status=status,
        solver=name,
        objective=request.objective,
        interval_minutes=request.interval_minutes,
        horizon=request.horizon,
        totals=_totals(model, objective_value),
        intervals=extract_plan(model, request),
        diagnostics={
            "pulp_status": pulp.LpStatus[raw_status],
            "variables": len(prob.variables()),
            "constraints": len(prob.constraints),
        },
    )
