"""Refusal semantics, violation naming and hosting capacity."""

from __future__ import annotations

import pytest

from gridmodel.powerflow import evaluate
from gridmodel.schemas import (
    Bus,
    BusKind,
    CandidateChange,
    FeasibilityRequest,
    FeasibilityStatus,
    HostingCapacityQuery,
    Injection,
    Limits,
    Line,
    NetworkModel,
    ViolationKind,
)

from factories import feeder_with_transformer, two_bus_line


def test_a_model_with_no_source_is_unavailable_not_feasible() -> None:
    model = NetworkModel(buses=[Bus(code="LV", nominal_kv=0.415)])
    response = evaluate(FeasibilityRequest(network=model))
    assert response.status is FeasibilityStatus.MODEL_UNAVAILABLE
    assert "no source bus" in (response.reason or "")
    assert response.buses == []


def test_an_islanded_bus_is_unavailable_and_named() -> None:
    model = NetworkModel(
        buses=[
            Bus(code="SS", nominal_kv=11.0, kind=BusKind.SOURCE),
            Bus(code="F1", nominal_kv=11.0),
            Bus(code="ORPHAN", nominal_kv=11.0),
        ],
        lines=[
            Line(
                code="L1",
                from_bus="SS",
                to_bus="F1",
                length_km=1.0,
                r_ohm_per_km=0.4,
                x_ohm_per_km=0.3,
                max_i_ka=0.2,
            )
        ],
    )
    response = evaluate(FeasibilityRequest(network=model))
    assert response.status is FeasibilityStatus.MODEL_UNAVAILABLE
    assert "ORPHAN" in (response.reason or "")


def test_several_buses_with_no_topology_is_unavailable() -> None:
    model = NetworkModel(
        buses=[
            Bus(code="SS", nominal_kv=11.0, kind=BusKind.SOURCE),
            Bus(code="LV", nominal_kv=0.415),
        ]
    )
    response = evaluate(FeasibilityRequest(network=model))
    assert response.status is FeasibilityStatus.MODEL_UNAVAILABLE
    assert "topology is missing" in (response.reason or "")


def test_an_injection_at_an_unknown_bus_is_unavailable() -> None:
    response = evaluate(
        FeasibilityRequest(
            network=two_bus_line(),
            loads=[Injection(bus="NOWHERE", p_w=1000.0)],
        )
    )
    assert response.status is FeasibilityStatus.MODEL_UNAVAILABLE
    assert "NOWHERE" in (response.reason or "")


def test_a_light_load_is_feasible_with_every_element_reported() -> None:
    response = evaluate(
        FeasibilityRequest(
            network=feeder_with_transformer(),
            loads=[Injection(bus="LV", p_w=50_000.0, q_var=15_000.0)],
        )
    )
    assert response.status is FeasibilityStatus.FEASIBLE
    assert response.violations == []
    assert {element.code for element in response.elements} == {"L1", "TX1"}
    assert {bus.code for bus in response.buses} == {"SS", "F1", "LV"}


def test_an_award_over_the_transformer_rating_names_the_element() -> None:
    """The acceptance case: a candidate change that overloads the transformer is
    reported as a violation naming `TX1`, with the award's own reference, so the
    market can refuse that award rather than the whole node."""
    response = evaluate(
        FeasibilityRequest(
            network=feeder_with_transformer(sn_mva=0.25),
            loads=[Injection(bus="LV", p_w=180_000.0, q_var=60_000.0)],
            candidate=[
                CandidateChange(bus="LV", delta_p_w=-120_000.0, reference="award-7")
            ],
        )
    )
    assert response.status is FeasibilityStatus.VIOLATIONS
    overload = [
        violation
        for violation in response.violations
        if violation.kind is ViolationKind.TRANSFORMER_LOADING
    ]
    assert len(overload) == 1
    assert overload[0].element == "TX1"
    assert overload[0].value > 100.0
    assert overload[0].candidate_references == ["award-7"]


def test_the_same_case_without_the_candidate_is_feasible() -> None:
    """Proves the refusal above is attributable to the award and not to the base
    case: the market must not refuse an award for a pre-existing overload."""
    response = evaluate(
        FeasibilityRequest(
            network=feeder_with_transformer(sn_mva=0.25),
            loads=[Injection(bus="LV", p_w=180_000.0, q_var=60_000.0)],
        )
    )
    assert response.status is FeasibilityStatus.FEASIBLE


def test_export_beyond_the_voltage_band_is_an_overvoltage_violation() -> None:
    response = evaluate(
        FeasibilityRequest(
            network=two_bus_line(length_km=20.0),
            generation=[Injection(bus="END", p_w=1_500_000.0)],
            limits=Limits(vm_pu_min=0.95, vm_pu_max=1.05),
        )
    )
    assert response.status is FeasibilityStatus.VIOLATIONS
    kinds = {violation.kind for violation in response.violations}
    assert ViolationKind.BUS_OVERVOLTAGE in kinds


def test_a_per_bus_band_overrides_the_request_band() -> None:
    tight = NetworkModel(
        buses=[
            Bus(code="SS", nominal_kv=11.0, kind=BusKind.SOURCE),
            Bus(code="END", nominal_kv=11.0, vm_pu_min=0.999, vm_pu_max=1.001),
        ],
        lines=two_bus_line().lines,
    )
    response = evaluate(
        FeasibilityRequest(
            network=tight,
            loads=[Injection(bus="END", p_w=300_000.0)],
        )
    )
    assert response.status is FeasibilityStatus.VIOLATIONS
    assert response.violations[0].kind is ViolationKind.BUS_UNDERVOLTAGE
    assert response.violations[0].element == "END"
    assert response.violations[0].limit == pytest.approx(0.999)


def test_hosting_capacity_is_a_value_that_solves_clean() -> None:
    """The reported headroom must itself be feasible. Reporting a bracket
    midpoint would invite an operator to connect exactly enough to violate."""
    request = FeasibilityRequest(
        network=feeder_with_transformer(sn_mva=0.25),
        loads=[Injection(bus="LV", p_w=50_000.0)],
        hosting_capacity=[
            HostingCapacityQuery(bus="LV", direction="injection", limit_w=2_000_000.0)
        ],
    )
    response = evaluate(request)
    assert response.status is FeasibilityStatus.FEASIBLE
    result = response.hosting_capacity[0]
    assert result.headroom_w > 0
    assert result.limiting_element is not None
    assert not result.capped

    at_headroom = evaluate(
        FeasibilityRequest(
            network=request.network,
            loads=request.loads,
            candidate=[CandidateChange(bus="LV", delta_p_w=result.headroom_w)],
        )
    )
    assert at_headroom.status is FeasibilityStatus.FEASIBLE

    beyond = evaluate(
        FeasibilityRequest(
            network=request.network,
            loads=request.loads,
            candidate=[
                CandidateChange(bus="LV", delta_p_w=result.headroom_w * 1.5 + 10_000.0)
            ],
        )
    )
    assert beyond.status is FeasibilityStatus.VIOLATIONS


def test_hosting_capacity_is_zero_when_the_base_case_already_violates() -> None:
    response = evaluate(
        FeasibilityRequest(
            network=feeder_with_transformer(sn_mva=0.1),
            loads=[Injection(bus="LV", p_w=200_000.0)],
            hosting_capacity=[HostingCapacityQuery(bus="LV", limit_w=500_000.0)],
        )
    )
    assert response.status is FeasibilityStatus.VIOLATIONS
    result = response.hosting_capacity[0]
    assert result.headroom_w == 0.0
    assert result.limiting_element == "TX1"


def test_hosting_capacity_reports_when_it_hit_the_search_ceiling() -> None:
    response = evaluate(
        FeasibilityRequest(
            network=feeder_with_transformer(sn_mva=2.5),
            hosting_capacity=[HostingCapacityQuery(bus="LV", limit_w=1_000.0)],
        )
    )
    result = response.hosting_capacity[0]
    assert result.capped
    assert result.headroom_w == 1_000.0
    assert result.limiting_element is None


def test_a_hosting_query_for_an_unknown_bus_is_unavailable() -> None:
    response = evaluate(
        FeasibilityRequest(
            network=two_bus_line(),
            hosting_capacity=[HostingCapacityQuery(bus="NOWHERE")],
        )
    )
    assert response.status is FeasibilityStatus.MODEL_UNAVAILABLE


def test_line_overload_is_reported_against_the_line() -> None:
    response = evaluate(
        FeasibilityRequest(
            network=two_bus_line(max_i_ka=0.01),
            loads=[Injection(bus="END", p_w=400_000.0)],
        )
    )
    assert response.status is FeasibilityStatus.VIOLATIONS
    assert any(
        violation.kind is ViolationKind.LINE_LOADING and violation.element == "L1"
        for violation in response.violations
    )
