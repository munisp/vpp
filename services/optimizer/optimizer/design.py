"""Minigrid design (sizing) studies.

Two engines, with different jobs, and the response says which produced what:

1. A priority-dispatch simulation over every interval of the submitted
   profile, for every candidate sizing. This is what the annual energy,
   fuel, CO2 and LCOE figures come from. It is arithmetic, not a solve, so
   the same request always produces the same answer — a study a developer
   put in a board pack has to be reproducible.

2. The platform's existing dispatch MILP (`dispatch.solve_dispatch`), run
   once on the recommendation's hardest day. It answers "could a
   cost-optimal schedule have served more than the rule the simulation
   follows?" and is reported alongside, never used to choose a candidate.

There is no second solver here, and no cost library: every price, every
capex and the tolerance for unserved energy come from the caller.
"""

from __future__ import annotations

import logging
import math

from .design_schemas import (
    BackupSource,
    BaselineResult,
    CandidateResult,
    DesignProvenance,
    DesignRequest,
    DesignResponse,
    DesignStatus,
    DispatchCheck,
    Economics,
    ResourceProfile,
    SizingSweep,
)
from .dispatch import solve_dispatch
from .schemas import (
    Asset,
    BatterySpec,
    DispatchRequest,
    GenerationSpec,
    Objective,
    Prices,
    Site,
)

logger = logging.getLogger(__name__)

DAYS_PER_YEAR = 365.0
# The state of charge the first warm-up pass starts from. It is not the state
# the accounted pass starts from: see `_simulate`.
SEED_SOC_FRACTION_OF_USABLE = 0.5
# How many times the profile is replayed looking for a state of charge it both
# starts and ends on. Bounded so a profile that never settles still answers.
MAX_WARMUP_PASSES = 8
WARMUP_TOLERANCE_KWH = 1e-6
# Net storage drawdown over the accounted pass, as a share of demand, above
# which the study says so. A profile whose storage ends emptier than it started
# served some load from energy the profile never generated.
DRAWDOWN_NOTE_THRESHOLD = 0.005


class _Simulation:
    """Energy balance of one candidate over the whole submitted profile.

    All quantities are kWh over the profile, before annualisation.
    """

    def __init__(self) -> None:
        self.demand_kwh = 0.0
        self.renewable_kwh = 0.0
        self.curtailed_kwh = 0.0
        self.backup_kwh = 0.0
        self.unserved_kwh = 0.0
        self.charge_kwh = 0.0
        self.discharge_kwh = 0.0
        # Unserved energy per day, so the hardest day can be named.
        self.unserved_by_day: list[float] = []
        self.demand_by_day: list[float] = []
        self.initial_stored_kwh = 0.0
        self.final_stored_kwh = 0.0

    @property
    def served_kwh(self) -> float:
        return self.demand_kwh - self.unserved_kwh

    @property
    def storage_drawdown_kwh(self) -> float:
        """Storage the profile ended without. Positive means some load was
        served from energy the simulated period never generated."""

        return self.initial_stored_kwh - self.final_stored_kwh


def _renewable_kw(
    resources: list[ResourceProfile], sizes: dict[str, float], index: int
) -> float:
    total = 0.0
    for resource in resources:
        capacity_kw = sizes.get(resource.kind, 0.0)
        if capacity_kw > 0:
            total += capacity_kw * resource.capacity_factor[index]
    return total


def _simulate(
    request: DesignRequest,
    pv_kw: float,
    wind_kw: float,
    battery_kwh: float,
    battery_kw: float,
) -> _Simulation:
    """Priority dispatch over the profile, accounted from a warmed-up state.

    Renewable serves load, surplus charges storage, deficit draws storage then
    the backup source, and whatever is left is unserved. No foresight, so the
    result is a floor on what good control achieves, not a claim about it.

    The pass that produces the reported numbers starts from the state of charge
    the profile settles on when replayed: unaccounted passes run until the state
    they end on is the state they began on. A battery assumed half full at hour
    zero would otherwise hand the site energy the profile never generated — and,
    once annualised, hand it that energy on every one of the 365 days.
    """

    stored: float | None = None
    for _ in range(MAX_WARMUP_PASSES):
        warm = _pass(request, pv_kw, wind_kw, battery_kwh, battery_kw, stored)
        if abs(warm.final_stored_kwh - warm.initial_stored_kwh) <= WARMUP_TOLERANCE_KWH:
            break
        stored = warm.final_stored_kwh
    return _pass(request, pv_kw, wind_kw, battery_kwh, battery_kw, stored)


def _pass(
    request: DesignRequest,
    pv_kw: float,
    wind_kw: float,
    battery_kwh: float,
    battery_kw: float,
    initial_stored_kwh: float | None,
) -> _Simulation:
    sim = _Simulation()
    hours = request.interval_hours
    per_day = request.intervals_per_day
    sweep = request.sweep
    one_way_efficiency = math.sqrt(sweep.battery_round_trip_efficiency)
    usable_kwh = battery_kwh * sweep.battery_usable_fraction
    stored_kwh = (
        usable_kwh * SEED_SOC_FRACTION_OF_USABLE
        if initial_stored_kwh is None
        else min(initial_stored_kwh, usable_kwh)
    )
    sim.initial_stored_kwh = stored_kwh
    backup_kw = request.backup.max_w / 1000.0
    sizes = {"solar_pv": pv_kw, "wind": wind_kw}

    day_unserved = 0.0
    day_demand = 0.0

    for index, load_w in enumerate(request.load.load_w):
        load_kw = load_w / 1000.0
        demand_kwh = load_kw * hours
        sim.demand_kwh += demand_kwh
        day_demand += demand_kwh

        available_kw = _renewable_kw(request.resources, sizes, index)
        sim.renewable_kwh += available_kw * hours

        surplus_kw = available_kw - load_kw
        if surplus_kw >= 0:
            # Charge with what the pack can take, in energy terms after losses.
            room_kwh = max(usable_kwh - stored_kwh, 0.0)
            charge_kw = min(surplus_kw, battery_kw, room_kwh / (hours * one_way_efficiency))
            if charge_kw > 0:
                stored_kwh += charge_kw * hours * one_way_efficiency
                sim.charge_kwh += charge_kw * hours
            sim.curtailed_kwh += (surplus_kw - charge_kw) * hours
        else:
            deficit_kw = -surplus_kw
            discharge_kw = min(
                deficit_kw, battery_kw, (stored_kwh * one_way_efficiency) / hours
            )
            if discharge_kw > 0:
                stored_kwh -= (discharge_kw * hours) / one_way_efficiency
                sim.discharge_kwh += discharge_kw * hours
            remaining_kw = deficit_kw - discharge_kw
            backup_available = (
                request.backup.available is None or request.backup.available[index]
            )
            backup_draw_kw = min(remaining_kw, backup_kw) if backup_available else 0.0
            sim.backup_kwh += backup_draw_kw * hours
            unserved_kwh = (remaining_kw - backup_draw_kw) * hours
            sim.unserved_kwh += unserved_kwh
            day_unserved += unserved_kwh

        if (index + 1) % per_day == 0:
            sim.unserved_by_day.append(day_unserved)
            sim.demand_by_day.append(day_demand)
            day_unserved = 0.0
            day_demand = 0.0

    sim.final_stored_kwh = stored_kwh
    return sim


def _fuel_and_emissions(
    backup: BackupSource, backup_kwh: float
) -> tuple[float | None, float | None]:
    litres = None if backup.fuel_litres_per_kwh is None else backup_kwh * backup.fuel_litres_per_kwh
    emissions_kg = (
        None if backup.emissions_g_per_kwh is None else backup_kwh * backup.emissions_g_per_kwh / 1000.0
    )
    return litres, emissions_kg


def _discount_factors(economics: Economics) -> list[float]:
    rate = economics.discount_rate_percent / 100.0
    return [1.0 / ((1.0 + rate) ** year) for year in range(1, economics.project_years + 1)]


def _levelised_cost(
    capex_cents: float,
    annual_cost_cents: float,
    annual_served_kwh: float,
    economics: Economics,
    battery_capex_cents: float,
) -> float | None:
    """Standard LCOE: discounted lifetime cost over discounted lifetime energy."""

    if annual_served_kwh <= 0:
        return None
    factors = _discount_factors(economics)
    cost = capex_cents + sum(annual_cost_cents * factor for factor in factors)
    if economics.battery_replacement_year is not None:
        replacement = battery_capex_cents * economics.battery_replacement_cost_fraction
        cost += replacement * factors[economics.battery_replacement_year - 1]
    energy = sum(annual_served_kwh * factor for factor in factors)
    return cost / energy


def _capex_cents(
    economics: Economics, pv_kw: float, wind_kw: float, battery_kwh: float, battery_kw: float,
    backup_kw: float,
) -> tuple[float, float]:
    battery_capex = battery_kwh * economics.battery_capex_cents_per_kwh
    inverter_kw = max(pv_kw + wind_kw, battery_kw)
    total = (
        pv_kw * economics.pv_capex_cents_per_kw
        + wind_kw * economics.wind_capex_cents_per_kw
        + battery_capex
        + inverter_kw * economics.inverter_capex_cents_per_kw
        + backup_kw * economics.backup_capex_cents_per_kw
    )
    return total, battery_capex


def _baseline(request: DesignRequest, annualisation: float) -> BaselineResult:
    """The backup source alone, which is what the site does today."""

    sim = _simulate(request, pv_kw=0.0, wind_kw=0.0, battery_kwh=0.0, battery_kw=0.0)
    backup_kwh = sim.backup_kwh * annualisation
    litres, emissions_kg = _fuel_and_emissions(request.backup, backup_kwh)
    annual_energy_cents = backup_kwh * request.backup.energy_cost_cents_per_kwh
    served = sim.served_kwh * annualisation
    lcoe = _levelised_cost(
        capex_cents=0.0,
        annual_cost_cents=annual_energy_cents,
        annual_served_kwh=served,
        economics=request.economics,
        battery_capex_cents=0.0,
    )
    return BaselineResult(
        kind=request.backup.kind,
        served_kwh_per_year=served,
        unmet_kwh_per_year=sim.unserved_kwh * annualisation,
        fuel_litres_per_year=litres,
        emissions_kg_per_year=emissions_kg,
        annual_energy_cents=annual_energy_cents,
        lcoe_cents_per_kwh=lcoe,
    )


def _evaluate_candidate(
    request: DesignRequest,
    annualisation: float,
    baseline: BaselineResult,
    pv_kw: float,
    wind_kw: float,
    battery_kwh: float,
) -> tuple[CandidateResult, _Simulation]:
    sweep: SizingSweep = request.sweep
    battery_kw = battery_kwh * sweep.battery_power_ratio
    sim = _simulate(request, pv_kw, wind_kw, battery_kwh, battery_kw)

    demand = sim.demand_kwh * annualisation
    served = sim.served_kwh * annualisation
    unmet = sim.unserved_kwh * annualisation
    backup_kwh = sim.backup_kwh * annualisation
    litres, emissions_kg = _fuel_and_emissions(request.backup, backup_kwh)

    capex, battery_capex = _capex_cents(
        request.economics, pv_kw, wind_kw, battery_kwh, battery_kw,
        request.backup.max_w / 1000.0,
    )
    annual_opex = capex * request.economics.fixed_opex_percent_of_capex_per_year / 100.0
    annual_fuel = backup_kwh * request.backup.energy_cost_cents_per_kwh
    lcoe = _levelised_cost(
        capex_cents=capex,
        annual_cost_cents=annual_opex + annual_fuel,
        annual_served_kwh=served,
        economics=request.economics,
        battery_capex_cents=battery_capex,
    )

    saving = baseline.annual_energy_cents - (annual_opex + annual_fuel)
    payback = capex / saving if saving > 0 and capex > 0 else None
    revenue = None if request.tariff_cents_per_kwh is None else served * request.tariff_cents_per_kwh

    result = CandidateResult(
        pv_kw=pv_kw,
        wind_kw=wind_kw,
        battery_kwh=battery_kwh,
        battery_kw=battery_kw,
        demand_kwh_per_year=demand,
        served_kwh_per_year=served,
        unmet_kwh_per_year=unmet,
        unmet_fraction=(unmet / demand) if demand > 0 else 0.0,
        renewable_kwh_per_year=sim.renewable_kwh * annualisation,
        curtailed_kwh_per_year=sim.curtailed_kwh * annualisation,
        backup_kwh_per_year=backup_kwh,
        renewable_fraction_of_served=((served - backup_kwh) / served) if served > 0 else 0.0,
        fuel_litres_per_year=litres,
        emissions_kg_per_year=emissions_kg,
        capex_cents=capex,
        annual_fixed_opex_cents=annual_opex,
        annual_fuel_cents=annual_fuel,
        lcoe_cents_per_kwh=lcoe,
        payback_years=payback,
        annual_revenue_cents=revenue,
        meets_unmet_limit=(
            (unmet / demand if demand > 0 else 0.0) <= request.max_unmet_fraction and lcoe is not None
        ),
    )
    return result, sim


def _rank_key(candidate: CandidateResult) -> tuple[float, float, float, float, float]:
    """Cheapest energy wins; ties break on capex then on size, so the ordering
    is total and the same inputs always yield the same recommendation."""

    return (
        candidate.lcoe_cents_per_kwh if candidate.lcoe_cents_per_kwh is not None else math.inf,
        candidate.capex_cents,
        candidate.pv_kw,
        candidate.wind_kw,
        candidate.battery_kwh,
    )


def _worst_day(sim: _Simulation) -> int:
    """The day the recommendation had the hardest time with: most unserved
    energy, or the heaviest day when nothing went unserved."""

    if sim.unserved_by_day and max(sim.unserved_by_day) > 0:
        return sim.unserved_by_day.index(max(sim.unserved_by_day))
    if sim.demand_by_day:
        return sim.demand_by_day.index(max(sim.demand_by_day))
    return 0


def _dispatch_check(
    request: DesignRequest, candidate: CandidateResult, sim: _Simulation
) -> DispatchCheck:
    if not request.dispatch_check:
        return DispatchCheck(ran=False, reason="the caller did not ask for a dispatch check")

    per_day = request.intervals_per_day
    day = _worst_day(sim)
    start = day * per_day
    end = start + per_day
    window = slice(start, end)

    if request.backup.available is not None and not all(request.backup.available[window]):
        # One import limit covers the whole horizon in the dispatch model, so a
        # backup that comes and goes inside the day cannot be represented.
        return DispatchCheck(
            ran=False,
            reason=(
                "the backup source is not available for the whole of the hardest day, and the "
                "dispatch model carries one import limit for the horizon"
            ),
            day_index=day,
        )

    sizes = {"solar_pv": candidate.pv_kw, "wind": candidate.wind_kw}
    generation_w = [
        _renewable_kw(request.resources, sizes, index) * 1000.0 for index in range(start, end)
    ]
    unserved_cost = request.backup.energy_cost_cents_per_kwh * 10.0 + 1000.0
    assets = [
        Asset(
            asset_id="renewable",
            asset_type="generation",
            generation=GenerationSpec(available_w=generation_w, curtailable=True),
        )
    ]
    if candidate.battery_kwh > 0:
        idle = (1.0 - request.sweep.battery_usable_fraction) * 100.0 / 2.0
        # The same state of charge the accounted pass entered the profile on, so
        # the two runs answer the same question.
        soc_percent = min(
            max(idle + 100.0 * sim.initial_stored_kwh / candidate.battery_kwh, idle),
            100.0 - idle,
        )
        assets.append(
            Asset(
                asset_id="storage",
                asset_type="battery",
                battery=BatterySpec(
                    capacity_wh=candidate.battery_kwh * 1000.0,
                    max_charge_w=candidate.battery_kw * 1000.0,
                    max_discharge_w=candidate.battery_kw * 1000.0,
                    initial_soc_percent=soc_percent,
                    soc_min_percent=idle,
                    soc_max_percent=100.0 - idle,
                    charge_efficiency=math.sqrt(request.sweep.battery_round_trip_efficiency),
                    discharge_efficiency=math.sqrt(request.sweep.battery_round_trip_efficiency),
                ),
            )
        )

    dispatch_request = DispatchRequest(
        interval_minutes=request.interval_minutes,
        site=Site(
            site_id="design-study",
            assets=assets,
            load_w=list(request.load.load_w[window]),
            max_import_w=request.backup.max_w,
            max_export_w=0.0,
            unserved_load_cost_cents_per_kwh=unserved_cost,
        ),
        prices=Prices(
            import_cents_per_kwh=[request.backup.energy_cost_cents_per_kwh] * per_day,
            export_cents_per_kwh=[0.0] * per_day,
        ),
        objective=Objective.MINIMIZE_COST,
    )
    result = solve_dispatch(dispatch_request)
    return DispatchCheck(
        ran=True,
        status=result.status,
        day_index=day,
        rule_based_unserved_wh=sim.unserved_by_day[day] * 1000.0 if sim.unserved_by_day else None,
        optimised_unserved_wh=result.totals.unserved_wh,
    )


def run_design_study(request: DesignRequest) -> DesignResponse:
    days = request.days
    annualisation = DAYS_PER_YEAR / days
    baseline = _baseline(request, annualisation)

    evaluated: list[tuple[CandidateResult, _Simulation]] = []
    for pv_kw in request.sweep.pv_kw:
        for wind_kw in request.sweep.wind_kw:
            for battery_kwh in request.sweep.battery_kwh:
                evaluated.append(
                    _evaluate_candidate(request, annualisation, baseline, pv_kw, wind_kw, battery_kwh)
                )

    candidates = [candidate for candidate, _ in evaluated]
    feasible = [pair for pair in evaluated if pair[0].meets_unmet_limit]
    notes: list[str] = [
        "annual energy, fuel, CO2 and LCOE come from a priority-dispatch simulation of every "
        "interval submitted, not from an optimised annual schedule",
        "storage enters the accounted profile on the state of charge an unaccounted warm-up "
        "pass ended on, so no candidate is credited with energy the profile never generated",
    ]
    if days < DAYS_PER_YEAR:
        notes.append(
            f"the profile covers {days:.0f} days; annual figures are scaled by "
            f"{annualisation:.2f} and are an extrapolation, not a measured year"
        )

    provenance = DesignProvenance(
        load_source=request.load.source,
        load_reference=request.load.reference,
        resource_sources={resource.kind: resource.source for resource in request.resources},
        resource_references={resource.kind: resource.reference for resource in request.resources},
        days_simulated=days,
        annualisation_factor=annualisation,
        backup_availability=(
            "declared_per_interval"
            if request.backup.available is not None
            else "assumed_always_available"
        ),
        notes=notes,
    )
    diagnostics: dict[str, str | float | int | bool] = {
        "candidates_evaluated": len(candidates),
        "candidates_within_unmet_limit": len(feasible),
        "intervals_simulated": request.horizon,
    }

    if not feasible:
        best_unmet = min(candidate.unmet_fraction for candidate in candidates)
        return DesignResponse(
            status=DesignStatus.NO_FEASIBLE_CANDIDATE,
            reason=(
                f"no candidate sizing kept unserved demand within {request.max_unmet_fraction:.1%}; "
                f"the closest left {best_unmet:.1%} unserved. Widen the sweep, raise the backup "
                "capacity, or state a tolerance the site can actually accept"
            ),
            interval_minutes=request.interval_minutes,
            recommended=None,
            baseline=baseline,
            candidates=candidates,
            provenance=provenance,
            dispatch_check=DispatchCheck(
                ran=False, reason="there is no recommendation to check"
            ),
            diagnostics=diagnostics,
        )

    recommended, recommended_sim = min(feasible, key=lambda pair: _rank_key(pair[0]))
    drawdown = recommended_sim.storage_drawdown_kwh
    diagnostics["recommended_storage_drawdown_kwh"] = drawdown
    if recommended_sim.demand_kwh > 0 and (
        drawdown / recommended_sim.demand_kwh > DRAWDOWN_NOTE_THRESHOLD
    ):
        provenance.notes.append(
            f"the recommendation ends the profile {drawdown:.1f} kWh emptier than it started, "
            f"which is {drawdown / recommended_sim.demand_kwh:.1%} of demand served from stored "
            "energy the profile did not generate; submit a longer profile to size storage on it"
        )
    return DesignResponse(
        status=DesignStatus.OPTIMAL,
        reason=None,
        interval_minutes=request.interval_minutes,
        recommended=recommended,
        baseline=baseline,
        candidates=candidates,
        provenance=provenance,
        dispatch_check=_dispatch_check(request, recommended, recommended_sim),
        diagnostics=diagnostics,
    )
