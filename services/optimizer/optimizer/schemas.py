"""Request/response schemas for the dispatch optimization service.

Unit conventions at the API boundary (matching the platform's TypeScript side):

* power              watts (positive = export/discharge, negative = import/charge)
* energy             watt-hours
* price              cents per kWh
* carbon intensity   grams CO2e per kWh
* money              cents

Internally the models work in kW/kWh to keep the LP numerically well
conditioned; conversion happens only in this module's helpers.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, model_validator

W_PER_KW = 1000.0


class Objective(str, Enum):
    MINIMIZE_COST = "minimize_cost"
    MAXIMIZE_REVENUE = "maximize_revenue"
    MINIMIZE_EMISSIONS = "minimize_emissions"
    MAXIMIZE_SELF_CONSUMPTION = "maximize_self_consumption"
    BALANCE_GRID = "balance_grid"


class SolveStatus(str, Enum):
    OPTIMAL = "optimal"
    INFEASIBLE = "infeasible"
    UNBOUNDED = "unbounded"
    NOT_SOLVED = "not_solved"
    NOT_CONVERGED = "not_converged"


class BatterySpec(BaseModel):
    """Storage asset with explicit round-trip efficiency and SoC limits."""

    capacity_wh: float = Field(gt=0)
    max_charge_w: float = Field(gt=0)
    max_discharge_w: float = Field(gt=0)
    initial_soc_percent: float = Field(ge=0, le=100)
    soc_min_percent: float = Field(default=10.0, ge=0, le=100)
    soc_max_percent: float = Field(default=95.0, ge=0, le=100)
    charge_efficiency: float = Field(default=0.95, gt=0, le=1)
    discharge_efficiency: float = Field(default=0.95, gt=0, le=1)
    # Marginal cost of cycling the pack, applied to charge + discharge throughput.
    cycle_cost_cents_per_kwh: float = Field(default=0.0, ge=0)
    # Terminal SoC requirement (e.g. EV departure guarantee, reserve obligation).
    terminal_soc_percent: float | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def _check_soc_window(self) -> "BatterySpec":
        if self.soc_min_percent >= self.soc_max_percent:
            raise ValueError("soc_min_percent must be below soc_max_percent")
        if not (self.soc_min_percent <= self.initial_soc_percent <= self.soc_max_percent):
            raise ValueError(
                f"initial_soc_percent {self.initial_soc_percent} outside "
                f"[{self.soc_min_percent}, {self.soc_max_percent}]"
            )
        if self.terminal_soc_percent is not None and self.terminal_soc_percent > self.soc_max_percent:
            raise ValueError("terminal_soc_percent above soc_max_percent is unreachable")
        return self


class GenerationSpec(BaseModel):
    """Non-dispatchable generation (solar/wind) with optional curtailment."""

    # Per-interval available generation; length must equal the horizon.
    available_w: list[float]
    curtailable: bool = True


class FlexibleLoadSpec(BaseModel):
    """Load that may be shed at a stated cost (never shed for free)."""

    baseline_w: list[float]
    sheddable_fraction: float = Field(default=0.0, ge=0, le=1)
    shed_cost_cents_per_kwh: float = Field(default=0.0, ge=0)


class Asset(BaseModel):
    asset_id: str
    asset_type: Literal["battery", "generation", "flexible_load"]
    battery: BatterySpec | None = None
    generation: GenerationSpec | None = None
    flexible_load: FlexibleLoadSpec | None = None

    @model_validator(mode="after")
    def _check_spec_present(self) -> "Asset":
        spec: BaseModel | None
        if self.asset_type == "battery":
            spec = self.battery
        elif self.asset_type == "generation":
            spec = self.generation
        else:
            spec = self.flexible_load
        if spec is None:
            raise ValueError(f"asset {self.asset_id}: '{self.asset_type}' spec is required")
        return self


class Site(BaseModel):
    site_id: str
    assets: list[Asset] = Field(default_factory=list)
    # Inflexible site load per interval.
    load_w: list[float]
    max_import_w: float = Field(ge=0)
    max_export_w: float = Field(ge=0)
    # Cost of failing to serve load; required when the site may be short.
    unserved_load_cost_cents_per_kwh: float = Field(default=1000.0, ge=0)


class Prices(BaseModel):
    import_cents_per_kwh: list[float]
    export_cents_per_kwh: list[float]
    # Grid carbon intensity, required for emissions objectives.
    grid_emissions_g_per_kwh: list[float] | None = None


class ObjectiveWeights(BaseModel):
    """Weights for the composite objective, in cents per natural unit.

    The selected `objective` sets defaults; anything set here overrides them,
    which is how a caller expresses e.g. "minimise cost but price carbon at
    5 cents per kg".
    """

    cost: float = 1.0
    revenue: float = 1.0
    emissions_cents_per_kg: float = 0.0
    grid_deviation_cents_per_kwh: float = 0.0
    export_penalty_cents_per_kwh: float = 0.0


class DispatchRequest(BaseModel):
    interval_minutes: int = Field(gt=0, le=1440)
    site: Site
    prices: Prices
    objective: Objective = Objective.MINIMIZE_COST
    weights: ObjectiveWeights | None = None
    # Target net grid exchange per interval, required by BALANCE_GRID.
    grid_target_w: list[float] | None = None
    solver_time_limit_seconds: float = Field(default=30.0, gt=0)
    # Relative MIP gap; the solver stops once within this of proven optimality.
    solver_relative_gap: float = Field(default=0.0, ge=0, lt=1)

    @property
    def horizon(self) -> int:
        return len(self.site.load_w)

    @property
    def interval_hours(self) -> float:
        return self.interval_minutes / 60.0

    @model_validator(mode="after")
    def _check_series_lengths(self) -> "DispatchRequest":
        horizon = len(self.site.load_w)
        if horizon == 0:
            raise ValueError("site.load_w must not be empty; horizon is derived from it")

        def check(name: str, series: list[float]) -> None:
            if len(series) != horizon:
                raise ValueError(
                    f"{name} has {len(series)} entries but the horizon is {horizon} intervals"
                )

        check("prices.import_cents_per_kwh", self.prices.import_cents_per_kwh)
        check("prices.export_cents_per_kwh", self.prices.export_cents_per_kwh)
        if self.prices.grid_emissions_g_per_kwh is not None:
            check("prices.grid_emissions_g_per_kwh", self.prices.grid_emissions_g_per_kwh)
        for asset in self.site.assets:
            if asset.generation is not None:
                check(f"asset {asset.asset_id} generation.available_w", asset.generation.available_w)
            if asset.flexible_load is not None:
                check(f"asset {asset.asset_id} flexible_load.baseline_w", asset.flexible_load.baseline_w)
        if self.grid_target_w is not None:
            check("grid_target_w", self.grid_target_w)

        if self.objective is Objective.BALANCE_GRID and self.grid_target_w is None:
            raise ValueError("objective 'balance_grid' requires grid_target_w")
        needs_emissions = self.objective is Objective.MINIMIZE_EMISSIONS or (
            self.weights is not None and self.weights.emissions_cents_per_kg != 0
        )
        if needs_emissions and self.prices.grid_emissions_g_per_kwh is None:
            raise ValueError(
                "emissions objective requires prices.grid_emissions_g_per_kwh; "
                "the service will not substitute an assumed carbon intensity"
            )
        return self


class AssetSetpoint(BaseModel):
    asset_id: str
    # Positive = discharge/generate, negative = charge/consume.
    power_w: float
    soc_percent: float | None = None
    curtailed_w: float | None = None
    shed_w: float | None = None


class IntervalPlan(BaseModel):
    index: int
    offset_minutes: int
    grid_import_w: float
    grid_export_w: float
    unserved_load_w: float
    setpoints: list[AssetSetpoint]


class DispatchTotals(BaseModel):
    objective_value_cents: float
    import_cost_cents: float
    export_revenue_cents: float
    cycle_cost_cents: float
    unserved_load_cost_cents: float
    shed_cost_cents: float
    emissions_g: float | None
    imported_wh: float
    exported_wh: float
    curtailed_wh: float
    unserved_wh: float


class DispatchResponse(BaseModel):
    status: SolveStatus
    solver: str
    objective: Objective
    interval_minutes: int
    horizon: int
    totals: DispatchTotals
    intervals: list[IntervalPlan]
    diagnostics: dict[str, str | float | int | bool] = Field(default_factory=dict)


class Scenario(BaseModel):
    """One realisation of the uncertain parameters."""

    scenario_id: str
    probability: float = Field(gt=0, le=1)
    prices: Prices | None = None
    load_w: list[float] | None = None
    # Per-asset generation override, keyed by asset_id.
    generation_w: dict[str, list[float]] = Field(default_factory=dict)


class StochasticRequest(BaseModel):
    base: DispatchRequest
    scenarios: list[Scenario] = Field(min_length=1)
    # Intervals whose decisions must be identical across scenarios (here-and-now).
    first_stage_intervals: int = Field(default=1, ge=1)
    # CVaR confidence level; 0.95 = average of the worst 5% of scenarios.
    cvar_alpha: float = Field(default=0.95, ge=0, lt=1)
    # 0 = pure expected value, 1 = pure CVaR.
    cvar_weight: float = Field(default=0.0, ge=0, le=1)

    @model_validator(mode="after")
    def _check(self) -> "StochasticRequest":
        total = sum(s.probability for s in self.scenarios)
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"scenario probabilities sum to {total}, expected 1.0")
        if self.first_stage_intervals > self.base.horizon:
            raise ValueError("first_stage_intervals exceeds the horizon")
        ids = [s.scenario_id for s in self.scenarios]
        if len(set(ids)) != len(ids):
            raise ValueError("scenario_id values must be unique")
        return self


class ScenarioOutcome(BaseModel):
    scenario_id: str
    probability: float
    cost_cents: float


class StochasticResponse(BaseModel):
    status: SolveStatus
    solver: str
    interval_minutes: int
    horizon: int
    expected_cost_cents: float
    cvar_cents: float
    cvar_alpha: float
    # The here-and-now decisions, identical across scenarios by construction.
    first_stage: list[IntervalPlan]
    per_scenario: list[ScenarioOutcome]
    diagnostics: dict[str, str | float | int | bool] = Field(default_factory=dict)


class MPCStep(BaseModel):
    """Realised (measured) data for one control step of a rolling-horizon run."""

    load_w: float | None = None
    import_cents_per_kwh: float | None = None
    export_cents_per_kwh: float | None = None
    grid_emissions_g_per_kwh: float | None = None
    generation_w: dict[str, float] = Field(default_factory=dict)


class MPCRequest(BaseModel):
    base: DispatchRequest
    # Number of control steps to advance; each step re-solves the full horizon.
    steps: int = Field(gt=0, le=288)
    # Optional realised values per step. Where absent the forecast is used and
    # the step is flagged as forecast-driven in the response.
    realised: list[MPCStep] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self) -> "MPCRequest":
        if self.steps > self.base.horizon:
            raise ValueError("steps exceeds the horizon; nothing would remain to optimise")
        if self.realised and len(self.realised) < self.steps:
            raise ValueError("realised must cover every step when provided")
        return self


class MPCAppliedStep(BaseModel):
    step: int
    status: SolveStatus
    used_realised_data: bool
    applied: IntervalPlan
    horizon_remaining: int


class MPCResponse(BaseModel):
    status: SolveStatus
    solver: str
    interval_minutes: int
    steps: list[MPCAppliedStep]
    realised_cost_cents: float
    diagnostics: dict[str, str | float | int | bool] = Field(default_factory=dict)


class CoordinatedSite(BaseModel):
    request: DispatchRequest


class CoordinationRequest(BaseModel):
    """Multi-site dispatch sharing a constrained grid connection.

    Solved by dual decomposition: each site keeps its own MILP and the shared
    limit is priced. This is not quadratic-penalty ADMM — the subproblems are
    mixed-integer linear programs and PuLP has no quadratic support, so the
    proximal term would have to be linearised anyway.
    """

    sites: list[CoordinatedSite] = Field(min_length=1)
    # Aggregate net import cap per interval across all sites (watts).
    shared_import_limit_w: list[float]
    # Aggregate net export cap per interval across all sites (watts).
    shared_export_limit_w: list[float] | None = None
    max_iterations: int = Field(default=50, ge=1, le=500)
    # Convergence tolerance on shared-limit violation, in watts.
    tolerance_w: float = Field(default=100.0, gt=0)
    step_size_cents_per_kwh: float = Field(default=5.0, gt=0)

    @model_validator(mode="after")
    def _check(self) -> "CoordinationRequest":
        horizons = {s.request.horizon for s in self.sites}
        if len(horizons) != 1:
            raise ValueError(f"all sites must share one horizon, got {sorted(horizons)}")
        intervals = {s.request.interval_minutes for s in self.sites}
        if len(intervals) != 1:
            raise ValueError("all sites must share one interval length")
        horizon = horizons.pop()
        if len(self.shared_import_limit_w) != horizon:
            raise ValueError("shared_import_limit_w length must equal the horizon")
        if self.shared_export_limit_w is not None and len(self.shared_export_limit_w) != horizon:
            raise ValueError("shared_export_limit_w length must equal the horizon")
        ids = [s.request.site.site_id for s in self.sites]
        if len(set(ids)) != len(ids):
            raise ValueError("site_id values must be unique")
        return self


class CoordinationResponse(BaseModel):
    status: SolveStatus
    solver: str
    iterations: int
    # Max shared-limit violation in the returned plan; zero when feasible.
    max_violation_w: float
    converged: bool
    shadow_prices_cents_per_kwh: list[float]
    sites: list[DispatchResponse]
    diagnostics: dict[str, str | float | int | bool] = Field(default_factory=dict)
