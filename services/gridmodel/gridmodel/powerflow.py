"""Power flow and hosting capacity over a site network model, on pandapower.

No solver is written here. pandapower's Newton-Raphson does the flow; this module
is responsible for the two things that make its answer usable by the platform:

1. Refusing a model that cannot carry a meaningful answer. A model with no source
   bus, an island, or a bus nothing connects to would still produce numbers from
   a solver configured to be forgiving — numbers that describe a network that is
   not the site. Those cases return `model_unavailable` with the reason.
2. Reporting violations against named elements. "Infeasible" tells an operator
   nothing; "transformer TX-01 at 118% of 250 kVA" tells them what to fix and
   lets the market refuse exactly the award that caused it.
"""

from __future__ import annotations

import importlib.util
import math
from dataclasses import dataclass

import pandapower as pp
from pandapower.auxiliary import pandapowerNet

from .schemas import (
    BusResult,
    CandidateChange,
    ElementResult,
    FeasibilityRequest,
    FeasibilityResponse,
    FeasibilityStatus,
    HostingCapacityQuery,
    HostingCapacityResult,
    Injection,
    Limits,
    NetworkModel,
    Violation,
    ViolationKind,
)

W_PER_MW = 1_000_000.0
VAR_PER_MVAR = 1_000_000.0

#: Hosting capacity is reported to this resolution; searching finer than the
#: rating tolerance of real equipment would imply precision we do not have.
HOSTING_RESOLUTION_W = 100.0

#: pandapower's Newton-Raphson is JIT-compiled when numba is importable. It is an
#: optional accelerator, not a correctness dependency, so its absence is passed
#: through rather than warned about on every solve.
NUMBA_AVAILABLE = importlib.util.find_spec("numba") is not None


class ModelUnavailable(Exception):
    """The network model cannot support a power flow. Carries the operator-facing
    reason, which is shown verbatim rather than turned into a status code."""


@dataclass(frozen=True)
class SolvedCase:
    buses: list[BusResult]
    elements: list[ElementResult]
    violations: list[Violation]


class NetworkBuilder:
    """Builds a pandapower net from the request and keeps the code ↔ index maps.

    One instance is reused across the base case and every hosting-capacity probe,
    so the probes are run against exactly the network that produced the base
    result rather than a rebuilt approximation of it.
    """

    def __init__(self, model: NetworkModel) -> None:
        self._model = model
        self.net: pandapowerNet = pp.create_empty_network(name="vpp-site")
        self._bus_index: dict[str, int] = {}
        self._line_code: dict[int, str] = {}
        self._trafo_code: dict[int, str] = {}
        self._bus_band: dict[str, tuple[float | None, float | None]] = {}
        self._build()

    def _build(self) -> None:
        model = self._model
        codes = [bus.code for bus in model.buses]
        if len(set(codes)) != len(codes):
            raise ModelUnavailable("the network model repeats a bus code")

        sources = [bus for bus in model.buses if bus.kind.value == "source"]
        if not sources:
            raise ModelUnavailable(
                "the network model has no source bus: without a declared infeed "
                "there is nothing to solve the flow against"
            )

        for bus in model.buses:
            index = pp.create_bus(self.net, vn_kv=bus.nominal_kv, name=bus.code)
            self._bus_index[bus.code] = index
            self._bus_band[bus.code] = (bus.vm_pu_min, bus.vm_pu_max)

        for source in sources:
            pp.create_ext_grid(
                self.net, bus=self._bus_index[source.code], vm_pu=1.0, name=source.code
            )

        for line in model.lines:
            for end in (line.from_bus, line.to_bus):
                if end not in self._bus_index:
                    raise ModelUnavailable(
                        f"line {line.code} connects to bus {end}, which is not in the model"
                    )
            index = pp.create_line_from_parameters(
                self.net,
                from_bus=self._bus_index[line.from_bus],
                to_bus=self._bus_index[line.to_bus],
                length_km=line.length_km,
                r_ohm_per_km=line.r_ohm_per_km,
                x_ohm_per_km=line.x_ohm_per_km,
                c_nf_per_km=line.c_nf_per_km,
                max_i_ka=line.max_i_ka,
                parallel=line.parallel,
                name=line.code,
            )
            self._line_code[index] = line.code

        for trafo in model.transformers:
            for end in (trafo.hv_bus, trafo.lv_bus):
                if end not in self._bus_index:
                    raise ModelUnavailable(
                        f"transformer {trafo.code} connects to bus {end}, which is not in the model"
                    )
            index = pp.create_transformer_from_parameters(
                self.net,
                hv_bus=self._bus_index[trafo.hv_bus],
                lv_bus=self._bus_index[trafo.lv_bus],
                sn_mva=trafo.sn_mva,
                vn_hv_kv=trafo.vn_hv_kv,
                vn_lv_kv=trafo.vn_lv_kv,
                vk_percent=trafo.vk_percent,
                vkr_percent=trafo.vkr_percent,
                pfe_kw=trafo.pfe_kw,
                i0_percent=trafo.i0_percent,
                name=trafo.code,
            )
            self._trafo_code[index] = trafo.code

        if not model.lines and not model.transformers and len(model.buses) > 1:
            raise ModelUnavailable(
                "the network model has several buses and no lines or transformers "
                "between them: the topology is missing"
            )

        self._assert_connected()

    def _assert_connected(self) -> None:
        """Every bus must be reachable from a source, or the flow describes a
        different network than the site does."""
        adjacency: dict[str, set[str]] = {code: set() for code in self._bus_index}
        for line in self._model.lines:
            adjacency[line.from_bus].add(line.to_bus)
            adjacency[line.to_bus].add(line.from_bus)
        for trafo in self._model.transformers:
            adjacency[trafo.hv_bus].add(trafo.lv_bus)
            adjacency[trafo.lv_bus].add(trafo.hv_bus)

        seen: set[str] = set()
        stack = [bus.code for bus in self._model.buses if bus.kind.value == "source"]
        while stack:
            code = stack.pop()
            if code in seen:
                continue
            seen.add(code)
            stack.extend(adjacency[code] - seen)

        islanded = sorted(set(self._bus_index) - seen)
        if islanded:
            raise ModelUnavailable(
                "these buses are not connected to any source bus, so no flow "
                f"reaches them: {', '.join(islanded)}"
            )

    def bus_index(self, code: str, context: str) -> int:
        if code not in self._bus_index:
            raise ModelUnavailable(f"{context} refers to bus {code}, which is not in the model")
        return self._bus_index[code]

    def apply_injections(
        self,
        loads: list[Injection],
        generation: list[Injection],
        candidate: list[CandidateChange],
    ) -> None:
        """Net every bus to a single load element.

        Netting is deliberate: it keeps the applied case identical whether the
        caller sent one asset per bus or twenty, and it makes a candidate change
        arithmetic on the same quantity the flow is solved for.
        """
        net_p_w: dict[str, float] = {}
        net_q_var: dict[str, float] = {}

        for load in loads:
            code = load.bus
            self.bus_index(code, "a load")
            net_p_w[code] = net_p_w.get(code, 0.0) + load.p_w
            net_q_var[code] = net_q_var.get(code, 0.0) + load.q_var
        for gen in generation:
            code = gen.bus
            self.bus_index(code, "a generator")
            net_p_w[code] = net_p_w.get(code, 0.0) - gen.p_w
            net_q_var[code] = net_q_var.get(code, 0.0) - gen.q_var
        for change in candidate:
            code = change.bus
            self.bus_index(code, "a candidate change")
            net_p_w[code] = net_p_w.get(code, 0.0) - change.delta_p_w
            net_q_var[code] = net_q_var.get(code, 0.0) - change.delta_q_var

        self.net.load = self.net.load.iloc[0:0]
        for code, p_w in net_p_w.items():
            pp.create_load(
                self.net,
                bus=self._bus_index[code],
                p_mw=p_w / W_PER_MW,
                q_mvar=net_q_var.get(code, 0.0) / VAR_PER_MVAR,
                name=f"net@{code}",
            )

    def band_for(self, code: str, limits: Limits) -> tuple[float, float]:
        low, high = self._bus_band.get(code, (None, None))
        return (
            limits.vm_pu_min if low is None else low,
            limits.vm_pu_max if high is None else high,
        )

    def solve(self, limits: Limits, candidate: list[CandidateChange]) -> SolvedCase:
        try:
            pp.runpp(
                self.net,
                calculate_voltage_angles=True,
                init="auto",
                numba=NUMBA_AVAILABLE,
            )
        except Exception as exc:  # pandapower raises LoadflowNotConverged and others
            raise NotConverged(str(exc)) from exc
        if not bool(self.net.converged):
            raise NotConverged("the power flow did not converge")

        references = [c.reference for c in candidate if c.reference]

        buses: list[BusResult] = []
        violations: list[Violation] = []
        for index, row in self.net.res_bus.iterrows():
            code = str(self.net.bus.at[index, "name"])
            low, high = self.band_for(code, limits)
            vm_pu = float(row["vm_pu"])
            buses.append(
                BusResult(
                    code=code,
                    vm_pu=vm_pu,
                    va_degree=float(row["va_degree"]),
                    p_w=float(row["p_mw"]) * W_PER_MW,
                    q_var=float(row["q_mvar"]) * VAR_PER_MVAR,
                    vm_pu_min=low,
                    vm_pu_max=high,
                )
            )
            if math.isnan(vm_pu):
                raise NotConverged(f"bus {code} solved to no voltage")
            if vm_pu < low:
                violations.append(
                    Violation(
                        kind=ViolationKind.BUS_UNDERVOLTAGE,
                        element=code,
                        value=vm_pu,
                        limit=low,
                        candidate_references=references,
                    )
                )
            elif vm_pu > high:
                violations.append(
                    Violation(
                        kind=ViolationKind.BUS_OVERVOLTAGE,
                        element=code,
                        value=vm_pu,
                        limit=high,
                        candidate_references=references,
                    )
                )

        elements: list[ElementResult] = []
        for index, row in self.net.res_line.iterrows():
            code = self._line_code[index]
            loading = float(row["loading_percent"])
            elements.append(
                ElementResult(
                    code=code,
                    kind="line",
                    loading_percent=loading,
                    limit_percent=limits.max_line_loading_percent,
                )
            )
            if loading > limits.max_line_loading_percent:
                violations.append(
                    Violation(
                        kind=ViolationKind.LINE_LOADING,
                        element=code,
                        value=loading,
                        limit=limits.max_line_loading_percent,
                        candidate_references=references,
                    )
                )

        for index, row in self.net.res_trafo.iterrows():
            code = self._trafo_code[index]
            loading = float(row["loading_percent"])
            elements.append(
                ElementResult(
                    code=code,
                    kind="transformer",
                    loading_percent=loading,
                    limit_percent=limits.max_transformer_loading_percent,
                )
            )
            if loading > limits.max_transformer_loading_percent:
                violations.append(
                    Violation(
                        kind=ViolationKind.TRANSFORMER_LOADING,
                        element=code,
                        value=loading,
                        limit=limits.max_transformer_loading_percent,
                        candidate_references=references,
                    )
                )

        return SolvedCase(buses=buses, elements=elements, violations=violations)


class NotConverged(Exception):
    """The solver ran and produced no usable solution."""


def _first_violation(case: SolvedCase) -> Violation | None:
    return case.violations[0] if case.violations else None


def _probe(
    request: FeasibilityRequest, extra: CandidateChange
) -> Violation | None:
    """Solve the base case plus one extra change, returning the binding violation."""
    builder = NetworkBuilder(request.network)
    builder.apply_injections(
        request.loads, request.generation, [*request.candidate, extra]
    )
    try:
        case = builder.solve(request.limits, [*request.candidate, extra])
    except NotConverged:
        # A probe that will not converge is treated as the ceiling of what the
        # network can take, not as an error: the answer below it is still valid.
        return Violation(
            kind=ViolationKind.BUS_UNDERVOLTAGE,
            element="power_flow",
            value=0.0,
            limit=request.limits.vm_pu_min,
        )
    return _first_violation(case)


def hosting_capacity(
    request: FeasibilityRequest, query: HostingCapacityQuery
) -> HostingCapacityResult:
    """Largest additional power the bus can take before the first violation.

    Bisection over a monotone-in-practice quantity: more injection means higher
    local voltage and more element loading. The reported figure is the last value
    that *solved clean*, never the midpoint of a bracket, so acting on it cannot
    create the violation it was meant to avoid.
    """
    sign = 1.0 if query.direction == "injection" else -1.0

    ceiling = query.limit_w
    at_ceiling = _probe(
        request, CandidateChange(bus=query.bus, delta_p_w=sign * ceiling, reference="hosting_probe")
    )
    if at_ceiling is None:
        return HostingCapacityResult(
            bus=query.bus,
            direction=query.direction,
            headroom_w=ceiling,
            limiting_element=None,
            limiting_kind=None,
            capped=True,
            searched_to_w=ceiling,
        )

    at_zero = _probe(
        request, CandidateChange(bus=query.bus, delta_p_w=0.0, reference="hosting_probe")
    )
    if at_zero is not None:
        # Already violated before any addition: there is no headroom, and the
        # element that binds is the one already over its limit.
        return HostingCapacityResult(
            bus=query.bus,
            direction=query.direction,
            headroom_w=0.0,
            limiting_element=at_zero.element,
            limiting_kind=at_zero.kind,
            capped=False,
            searched_to_w=ceiling,
        )

    low, high = 0.0, ceiling
    binding = at_ceiling
    while high - low > HOSTING_RESOLUTION_W:
        mid = (low + high) / 2.0
        violation = _probe(
            request,
            CandidateChange(bus=query.bus, delta_p_w=sign * mid, reference="hosting_probe"),
        )
        if violation is None:
            low = mid
        else:
            high = mid
            binding = violation

    return HostingCapacityResult(
        bus=query.bus,
        direction=query.direction,
        headroom_w=math.floor(low / HOSTING_RESOLUTION_W) * HOSTING_RESOLUTION_W,
        limiting_element=binding.element,
        limiting_kind=binding.kind,
        capped=False,
        searched_to_w=ceiling,
    )


def evaluate(request: FeasibilityRequest) -> FeasibilityResponse:
    """Evaluate the base case plus candidate changes, then any hosting queries."""
    try:
        builder = NetworkBuilder(request.network)
        builder.apply_injections(request.loads, request.generation, request.candidate)
    except ModelUnavailable as exc:
        return FeasibilityResponse(
            status=FeasibilityStatus.MODEL_UNAVAILABLE,
            study_reference=request.study_reference,
            reason=str(exc),
            diagnostics={"engine": "pandapower", "buses": len(request.network.buses)},
        )

    try:
        case = builder.solve(request.limits, request.candidate)
    except NotConverged as exc:
        return FeasibilityResponse(
            status=FeasibilityStatus.NOT_CONVERGED,
            study_reference=request.study_reference,
            reason=str(exc),
            diagnostics={"engine": "pandapower", "buses": len(request.network.buses)},
        )

    capacities: list[HostingCapacityResult] = []
    for query in request.hosting_capacity:
        try:
            builder.bus_index(query.bus, "a hosting capacity query")
        except ModelUnavailable as exc:
            return FeasibilityResponse(
                status=FeasibilityStatus.MODEL_UNAVAILABLE,
                study_reference=request.study_reference,
                reason=str(exc),
                diagnostics={"engine": "pandapower"},
            )
        capacities.append(hosting_capacity(request, query))

    return FeasibilityResponse(
        status=(
            FeasibilityStatus.VIOLATIONS if case.violations else FeasibilityStatus.FEASIBLE
        ),
        study_reference=request.study_reference,
        buses=case.buses,
        elements=case.elements,
        violations=case.violations,
        hosting_capacity=capacities,
        diagnostics={
            "engine": "pandapower",
            "engine_version": pp.__version__,
            "buses": len(request.network.buses),
            "lines": len(request.network.lines),
            "transformers": len(request.network.transformers),
            "candidate_changes": len(request.candidate),
        },
    )
