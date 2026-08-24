"""Request/response schemas for minigrid design (sizing) studies.

A design study answers "what should be built here, and what will it cost per
kWh" for a site that does not exist yet. It is deliberately separate from
dispatch: dispatch optimises an existing fleet over hours, a design study
evaluates candidate sizings over a year of operation.

Unit conventions match `schemas` (watts, watt-hours, cents per kWh, cents),
with two additions used only here:

* fuel        litres, and cents per litre
* emissions   grams CO2e (per kWh of backup generation)

Nothing is defaulted that would change an answer. There is no assumed solar
resource, no assumed load, no assumed diesel price, no assumed capex and no
assumed tolerance for unserved energy: a study that lacks any of them is
refused rather than answered with a plausible number.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .schemas import SolveStatus

# A study is annualised from whatever the series covers; a series shorter than
# this cannot say anything about a year and is refused.
MIN_DAYS = 1
MAX_DAYS = 366
MAX_CANDIDATES = 400


class ProfileSource(str, Enum):
    """Where a series came from. Carried through to the response so a reader
    can tell a measured year from a modelled one."""

    METERED = "metered"
    DECLARED = "declared"
    SOURCED = "sourced"
    SYNTHETIC = "synthetic"


class DesignStatus(str, Enum):
    OPTIMAL = "optimal"
    # Every candidate leaves more load unserved than the study allows.
    NO_FEASIBLE_CANDIDATE = "no_feasible_candidate"


class LoadProfile(BaseModel):
    """Site demand. `source` is not cosmetic: a study run on a synthetic
    profile must not be read as a study of the site's measured demand."""

    source: ProfileSource
    load_w: list[float] = Field(min_length=24)
    reference: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _check_values(self) -> "LoadProfile":
        for index, value in enumerate(self.load_w):
            if value < 0:
                raise ValueError(f"load_w[{index}] is negative; demand cannot be negative")
        if not any(value > 0 for value in self.load_w):
            raise ValueError("load_w is all zeroes; there is nothing to design for")
        return self


class ResourceProfile(BaseModel):
    """Per-interval output of one unit of installed capacity, i.e. a capacity
    factor series. 1.0 means the array produces its nameplate in that hour."""

    kind: Literal["solar_pv", "wind"]
    source: ProfileSource
    capacity_factor: list[float]
    reference: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _check_values(self) -> "ResourceProfile":
        for index, value in enumerate(self.capacity_factor):
            if value < 0 or value > 1.5:
                raise ValueError(
                    f"capacity_factor[{index}] is {value}; expected a per-unit factor in [0, 1.5]"
                )
        if not any(value > 0 for value in self.capacity_factor):
            raise ValueError("capacity_factor is all zeroes; this resource can never generate")
        return self


class BackupSource(BaseModel):
    """The dispatchable source that covers whatever the renewable plus storage
    cannot: a diesel genset, or a grid connection.

    One channel only. A site with both a genset and an unreliable grid needs
    two priced channels, which this model does not have — such a study is
    refused rather than answered as though the second source did not exist.
    """

    kind: Literal["genset", "grid"]
    max_w: float = Field(gt=0)
    energy_cost_cents_per_kwh: float = Field(ge=0)
    # Required to report fuel and CO2 for a genset; a grid channel reports
    # neither unless an emissions factor is given.
    fuel_litres_per_kwh: float | None = Field(default=None, gt=0)
    emissions_g_per_kwh: float | None = Field(default=None, ge=0)
    # Per-interval availability. Absent means always available, which for a
    # weak grid is an assumption the response labels.
    available: list[bool] | None = None

    @model_validator(mode="after")
    def _check(self) -> "BackupSource":
        if self.kind == "genset" and self.fuel_litres_per_kwh is None:
            raise ValueError(
                "a genset needs fuel_litres_per_kwh; without it the study cannot report "
                "fuel use, cost of diesel displaced or CO2"
            )
        return self


class Economics(BaseModel):
    """Costs and the discounting they are evaluated under. Every figure is a
    caller input: the service holds no cost library."""

    discount_rate_percent: float = Field(ge=0, lt=100)
    project_years: int = Field(ge=1, le=40)
    pv_capex_cents_per_kw: float = Field(ge=0)
    wind_capex_cents_per_kw: float = Field(default=0.0, ge=0)
    battery_capex_cents_per_kwh: float = Field(ge=0)
    inverter_capex_cents_per_kw: float = Field(default=0.0, ge=0)
    backup_capex_cents_per_kw: float = Field(default=0.0, ge=0)
    fixed_opex_percent_of_capex_per_year: float = Field(default=0.0, ge=0, le=100)
    # Storage replacement, priced as a fraction of the original battery capex.
    battery_replacement_year: int | None = Field(default=None, ge=1, le=40)
    battery_replacement_cost_fraction: float = Field(default=1.0, ge=0, le=2)

    @model_validator(mode="after")
    def _check(self) -> "Economics":
        if (
            self.battery_replacement_year is not None
            and self.battery_replacement_year > self.project_years
        ):
            raise ValueError(
                "battery_replacement_year falls outside the project life; it would never be paid"
            )
        return self


class SizingSweep(BaseModel):
    """The candidate sizings to evaluate. Explicit rather than a search range,
    so the same request always evaluates the same set."""

    pv_kw: list[float] = Field(min_length=1)
    battery_kwh: list[float] = Field(min_length=1)
    wind_kw: list[float] = Field(default_factory=lambda: [0.0])
    # Battery power as a multiple of its energy (0.5 = a two-hour battery).
    battery_power_ratio: float = Field(default=0.5, gt=0, le=4)
    battery_round_trip_efficiency: float = Field(default=0.90, gt=0, le=1)
    battery_usable_fraction: float = Field(default=0.90, gt=0, le=1)

    @model_validator(mode="after")
    def _check(self) -> "SizingSweep":
        for name, values in (
            ("pv_kw", self.pv_kw),
            ("battery_kwh", self.battery_kwh),
            ("wind_kw", self.wind_kw),
        ):
            for value in values:
                if value < 0:
                    raise ValueError(f"{name} contains {value}; capacity cannot be negative")
            if len(set(values)) != len(values):
                raise ValueError(f"{name} contains duplicates; each candidate must be distinct")
        combinations = len(self.pv_kw) * len(self.battery_kwh) * len(self.wind_kw)
        if combinations > MAX_CANDIDATES:
            raise ValueError(
                f"{combinations} candidate sizings exceeds the {MAX_CANDIDATES} limit; "
                "narrow the sweep"
            )
        return self


class DesignRequest(BaseModel):
    interval_minutes: int = Field(gt=0, le=1440)
    load: LoadProfile
    resources: list[ResourceProfile] = Field(min_length=1)
    backup: BackupSource
    economics: Economics
    sweep: SizingSweep
    # The share of annual demand the site is allowed to leave unserved. No
    # default: what counts as acceptable supply is a policy decision.
    max_unmet_fraction: float = Field(ge=0, le=1)
    # Optional revenue per kWh served, for payback against the diesel baseline.
    tariff_cents_per_kwh: float | None = Field(default=None, ge=0)
    # Run the dispatch MILP on the study's worst day for the recommendation.
    dispatch_check: bool = True

    @property
    def interval_hours(self) -> float:
        return self.interval_minutes / 60.0

    @property
    def intervals_per_day(self) -> int:
        return int(round(24 * 60 / self.interval_minutes))

    @property
    def horizon(self) -> int:
        return len(self.load.load_w)

    @property
    def days(self) -> float:
        return self.horizon / self.intervals_per_day

    @model_validator(mode="after")
    def _check(self) -> "DesignRequest":
        if (24 * 60) % self.interval_minutes != 0:
            raise ValueError("interval_minutes must divide a day evenly")
        horizon = len(self.load.load_w)
        per_day = int(round(24 * 60 / self.interval_minutes))
        if horizon % per_day != 0:
            raise ValueError(
                f"the load profile covers {horizon} intervals, which is not a whole number of "
                f"days at {self.interval_minutes}-minute resolution"
            )
        days = horizon // per_day
        if days < MIN_DAYS or days > MAX_DAYS:
            raise ValueError(f"the profile covers {days} days; expected between {MIN_DAYS} and {MAX_DAYS}")
        kinds = [resource.kind for resource in self.resources]
        if len(set(kinds)) != len(kinds):
            raise ValueError("give at most one profile per resource kind")
        for resource in self.resources:
            if len(resource.capacity_factor) != horizon:
                raise ValueError(
                    f"{resource.kind} capacity_factor has {len(resource.capacity_factor)} entries "
                    f"but the load profile has {horizon}"
                )
        if self.backup.available is not None and len(self.backup.available) != horizon:
            raise ValueError("backup.available must cover every interval of the profile")
        if any(size > 0 for size in self.sweep.wind_kw) and not any(
            resource.kind == "wind" for resource in self.resources
        ):
            raise ValueError("the sweep sizes wind but no wind resource profile was given")
        if any(size > 0 for size in self.sweep.pv_kw) and not any(
            resource.kind == "solar_pv" for resource in self.resources
        ):
            raise ValueError("the sweep sizes PV but no solar_pv resource profile was given")
        return self


class CandidateResult(BaseModel):
    """One sizing, simulated over the whole profile and annualised."""

    pv_kw: float
    wind_kw: float
    battery_kwh: float
    battery_kw: float
    # Energy over the simulated profile, scaled to a year.
    demand_kwh_per_year: float
    served_kwh_per_year: float
    unmet_kwh_per_year: float
    unmet_fraction: float
    renewable_kwh_per_year: float
    curtailed_kwh_per_year: float
    backup_kwh_per_year: float
    renewable_fraction_of_served: float
    fuel_litres_per_year: float | None
    emissions_kg_per_year: float | None
    capex_cents: float
    annual_fixed_opex_cents: float
    annual_fuel_cents: float
    # None when the candidate serves nothing at all, so there is no energy to
    # divide the cost by — never a zero standing in for "free".
    lcoe_cents_per_kwh: float | None
    # None when the candidate saves nothing against the baseline, rather than
    # a large number standing in for "never".
    payback_years: float | None
    annual_revenue_cents: float | None
    meets_unmet_limit: bool


class BaselineResult(BaseModel):
    """The do-nothing case: the backup source carries the whole load. This is
    what a Nigerian commercial site is paying today, and what a design study
    is measured against."""

    kind: Literal["genset", "grid"]
    served_kwh_per_year: float
    unmet_kwh_per_year: float
    fuel_litres_per_year: float | None
    emissions_kg_per_year: float | None
    annual_energy_cents: float
    lcoe_cents_per_kwh: float | None


class DispatchCheck(BaseModel):
    """The existing dispatch MILP, run on the recommendation's worst day.

    The annual figures come from a priority-dispatch simulation, not from this
    solve: the check says whether a cost-optimal schedule could have served
    more on the hardest day, and no candidate is chosen on its result.
    """

    ran: bool
    reason: str | None = None
    status: SolveStatus | None = None
    day_index: int | None = None
    rule_based_unserved_wh: float | None = None
    optimised_unserved_wh: float | None = None


class DesignProvenance(BaseModel):
    load_source: ProfileSource
    load_reference: str | None
    resource_sources: dict[str, ProfileSource]
    resource_references: dict[str, str | None]
    days_simulated: float
    annualisation_factor: float
    backup_availability: Literal["declared_per_interval", "assumed_always_available"]
    notes: list[str] = Field(default_factory=list)


class DesignResponse(BaseModel):
    status: DesignStatus
    reason: str | None = None
    interval_minutes: int
    # Null when no candidate stayed inside max_unmet_fraction: an unmet-load
    # limit that cannot be met is not answered with the least-bad sizing.
    recommended: CandidateResult | None
    baseline: BaselineResult
    candidates: list[CandidateResult]
    provenance: DesignProvenance
    dispatch_check: DispatchCheck
    diagnostics: dict[str, str | float | int | bool] = Field(default_factory=dict)
