"""Request and response types for the network feasibility service.

The types encode one rule: a feasibility answer is only meaningful against a
network model that can actually be solved. Anything missing — no source bus, an
island, a line with no rating — is reported as `model_unavailable` with the
reason, never as `feasible`, because "feasible" is what a caller uses to bind a
dispatch or pay an award.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class FeasibilityStatus(str, Enum):
    """Outcome of a feasibility evaluation."""

    #: Solved, and every limit in the request is respected.
    FEASIBLE = "feasible"
    #: Solved, and at least one limit is violated. Violations name the element.
    VIOLATIONS = "violations"
    #: The model cannot support a power flow at all; nothing was evaluated.
    MODEL_UNAVAILABLE = "model_unavailable"
    #: The solver ran and did not converge. Not the same as infeasible.
    NOT_CONVERGED = "not_converged"


class ViolationKind(str, Enum):
    BUS_UNDERVOLTAGE = "bus_undervoltage"
    BUS_OVERVOLTAGE = "bus_overvoltage"
    LINE_LOADING = "line_loading"
    TRANSFORMER_LOADING = "transformer_loading"


class BusKind(str, Enum):
    #: The infeed the flow is solved against (substation source / grid coupling).
    SOURCE = "source"
    #: Any other bus: a feeder section, a transformer terminal, a connection.
    NODE = "node"


class Bus(BaseModel):
    code: str = Field(min_length=1, max_length=80)
    nominal_kv: float = Field(gt=0)
    kind: BusKind = BusKind.NODE
    #: Per-unit voltage band for this bus. Falls back to the request-level band.
    vm_pu_min: float | None = Field(default=None, gt=0)
    vm_pu_max: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _band_ordered(self) -> "Bus":
        if self.vm_pu_min is not None and self.vm_pu_max is not None:
            if self.vm_pu_min >= self.vm_pu_max:
                raise ValueError(f"bus {self.code}: vm_pu_min must be below vm_pu_max")
        return self


class Line(BaseModel):
    code: str = Field(min_length=1, max_length=80)
    from_bus: str
    to_bus: str
    length_km: float = Field(gt=0)
    r_ohm_per_km: float = Field(gt=0)
    x_ohm_per_km: float = Field(gt=0)
    c_nf_per_km: float = Field(default=0.0, ge=0)
    #: Thermal rating. Required: loading without a rating is not a percentage.
    max_i_ka: float = Field(gt=0)
    parallel: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def _distinct_ends(self) -> "Line":
        if self.from_bus == self.to_bus:
            raise ValueError(f"line {self.code}: from_bus and to_bus are the same bus")
        return self


class Transformer(BaseModel):
    code: str = Field(min_length=1, max_length=80)
    hv_bus: str
    lv_bus: str
    #: Nameplate rating; this is the element an award most often violates.
    sn_mva: float = Field(gt=0)
    vn_hv_kv: float = Field(gt=0)
    vn_lv_kv: float = Field(gt=0)
    vk_percent: float = Field(gt=0)
    vkr_percent: float = Field(default=0.0, ge=0)
    pfe_kw: float = Field(default=0.0, ge=0)
    i0_percent: float = Field(default=0.0, ge=0)

    @model_validator(mode="after")
    def _distinct_ends(self) -> "Transformer":
        if self.hv_bus == self.lv_bus:
            raise ValueError(f"transformer {self.code}: hv_bus and lv_bus are the same bus")
        if self.vkr_percent > self.vk_percent:
            raise ValueError(
                f"transformer {self.code}: vkr_percent cannot exceed vk_percent"
            )
        return self


class NetworkModel(BaseModel):
    """The electrical model of one site or feeder area."""

    buses: list[Bus] = Field(min_length=1)
    lines: list[Line] = Field(default_factory=list)
    transformers: list[Transformer] = Field(default_factory=list)


class Injection(BaseModel):
    """Power at a bus, watts. Consumption is positive in `loads`, and injection
    is positive in `generation`; keeping them apart avoids a sign convention a
    caller can get backwards."""

    bus: str
    p_w: float
    q_var: float = 0.0
    #: Optional identity for reporting which asset drove a violation.
    reference: str | None = None


class CandidateChange(BaseModel):
    """A change under test: an award, a dispatch setpoint or a new connection.

    `delta_p_w` is signed in the *net injection* direction: positive exports into
    the network, negative consumes from it, so an import reduction and an export
    increase are the same arithmetic.
    """

    bus: str
    delta_p_w: float
    delta_q_var: float = 0.0
    reference: str | None = None


class HostingCapacityQuery(BaseModel):
    bus: str
    direction: Literal["injection", "consumption"] = "injection"
    #: Search ceiling. The answer is capped here and reports `capped=True`.
    limit_w: float = Field(default=5_000_000.0, gt=0)


class Limits(BaseModel):
    vm_pu_min: float = Field(default=0.95, gt=0)
    vm_pu_max: float = Field(default=1.05, gt=0)
    max_line_loading_percent: float = Field(default=100.0, gt=0)
    max_transformer_loading_percent: float = Field(default=100.0, gt=0)

    @model_validator(mode="after")
    def _band_ordered(self) -> "Limits":
        if self.vm_pu_min >= self.vm_pu_max:
            raise ValueError("vm_pu_min must be below vm_pu_max")
        return self


class FeasibilityRequest(BaseModel):
    network: NetworkModel
    loads: list[Injection] = Field(default_factory=list)
    generation: list[Injection] = Field(default_factory=list)
    candidate: list[CandidateChange] = Field(default_factory=list)
    limits: Limits = Field(default_factory=Limits)
    hosting_capacity: list[HostingCapacityQuery] = Field(default_factory=list)
    #: Identifier echoed back so a stored study can be matched to its request.
    study_reference: str | None = None


class BusResult(BaseModel):
    code: str
    vm_pu: float
    va_degree: float
    p_w: float
    q_var: float
    vm_pu_min: float
    vm_pu_max: float


class ElementResult(BaseModel):
    code: str
    kind: Literal["line", "transformer"]
    loading_percent: float
    limit_percent: float


class Violation(BaseModel):
    kind: ViolationKind
    #: Bus code or element code — the thing an operator has to act on.
    element: str
    value: float
    limit: float
    #: Which candidate references were in the evaluated case, for attribution.
    candidate_references: list[str] = Field(default_factory=list)


class HostingCapacityResult(BaseModel):
    bus: str
    direction: Literal["injection", "consumption"]
    #: Additional power the bus can take before the first violation, watts.
    headroom_w: float
    #: The element that binds. None when the search hit `limit_w` untroubled.
    limiting_element: str | None
    limiting_kind: ViolationKind | None
    capped: bool
    searched_to_w: float


class FeasibilityResponse(BaseModel):
    status: FeasibilityStatus
    study_reference: str | None = None
    #: Populated for MODEL_UNAVAILABLE; the caller shows this to an operator.
    reason: str | None = None
    buses: list[BusResult] = Field(default_factory=list)
    elements: list[ElementResult] = Field(default_factory=list)
    violations: list[Violation] = Field(default_factory=list)
    hosting_capacity: list[HostingCapacityResult] = Field(default_factory=list)
    diagnostics: dict[str, str | int | float | bool] = Field(default_factory=dict)
