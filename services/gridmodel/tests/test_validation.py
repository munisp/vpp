"""Engine validation: the service's numbers must match an independent solution.

The reference here is arithmetic, not another program. For a single line feeding a
constant-power load, the receiving-end voltage satisfies a quadratic that can be
solved in closed form, so the check is against the physics rather than against
pandapower agreeing with itself.

What is deliberately *not* claimed: the IEEE 4-node and 13-node distribution test
feeders publish per-phase solutions for deliberately unbalanced, four-wire
networks. pandapower's `runpp` is a positive-sequence solver, so reproducing
those published tables is out of scope for this engine and no test here asserts
that it does. Anything the platform reports from this service is a balanced
positive-sequence result, and the network-feasibility surfaces say so.
"""

from __future__ import annotations

import math

from gridmodel.powerflow import evaluate
from gridmodel.schemas import FeasibilityRequest, Injection

from factories import two_bus_line


def analytic_receiving_voltage_pu(
    *,
    nominal_kv: float,
    r_ohm: float,
    x_ohm: float,
    p_w: float,
    q_var: float,
) -> float:
    """Closed-form receiving-end voltage for a two-bus constant-power load.

    From |V2|^2 = |V1|^2 - 2(PR + QX) - (P^2 + Q^2)(R^2 + X^2)/|V2|^2, written as
    a quadratic in |V2|^2 and taking the upper (stable) root. Three-phase
    quantities with per-phase impedance, so the line-to-line base cancels.
    """
    v1_sq = (nominal_kv * 1000.0) ** 2
    b = 2.0 * (p_w * r_ohm + q_var * x_ohm) - v1_sq
    c = (p_w**2 + q_var**2) * (r_ohm**2 + x_ohm**2)
    discriminant = b**2 - 4.0 * c
    assert discriminant > 0, "the reference case must have a stable solution"
    v2_sq = (-b + math.sqrt(discriminant)) / 2.0
    return math.sqrt(v2_sq) / (nominal_kv * 1000.0)


def test_two_bus_voltage_matches_closed_form() -> None:
    nominal_kv = 11.0
    length_km = 5.0
    r_per_km, x_per_km = 0.4, 0.3
    p_w, q_var = 400_000.0, 150_000.0

    model = two_bus_line(
        nominal_kv=nominal_kv,
        length_km=length_km,
        r_ohm_per_km=r_per_km,
        x_ohm_per_km=x_per_km,
    )
    response = evaluate(
        FeasibilityRequest(
            network=model,
            loads=[Injection(bus="END", p_w=p_w, q_var=q_var)],
        )
    )

    expected = analytic_receiving_voltage_pu(
        nominal_kv=nominal_kv,
        r_ohm=r_per_km * length_km,
        x_ohm=x_per_km * length_km,
        p_w=p_w,
        q_var=q_var,
    )
    solved = {bus.code: bus.vm_pu for bus in response.buses}
    assert solved["SS"] == 1.0
    assert abs(solved["END"] - expected) < 1e-5, (solved["END"], expected)


def test_generation_at_the_end_raises_the_voltage_above_the_source() -> None:
    """Export at the far end must show up as a rise, which is the physical basis
    of every hosting-capacity answer the service gives."""
    model = two_bus_line()
    response = evaluate(
        FeasibilityRequest(
            network=model,
            generation=[Injection(bus="END", p_w=400_000.0)],
        )
    )
    solved = {bus.code: bus.vm_pu for bus in response.buses}
    assert solved["END"] > 1.0


def test_the_engine_conserves_power_across_the_line() -> None:
    """Losses must be positive and small for a lightly loaded line: a solver
    reporting more power arriving than left would invalidate every loading
    figure downstream."""
    p_w = 200_000.0
    response = evaluate(
        FeasibilityRequest(
            network=two_bus_line(),
            loads=[Injection(bus="END", p_w=p_w)],
        )
    )
    by_code = {bus.code: bus for bus in response.buses}
    source_injection_w = -by_code["SS"].p_w
    losses_w = source_injection_w - p_w
    assert losses_w > 0
    assert losses_w < 0.05 * p_w, losses_w
