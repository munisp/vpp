"""Network models used across the feasibility tests."""

from __future__ import annotations

from gridmodel.schemas import (
    Bus,
    BusKind,
    Line,
    NetworkModel,
    Transformer,
)


def two_bus_line(
    *,
    nominal_kv: float = 11.0,
    length_km: float = 5.0,
    r_ohm_per_km: float = 0.4,
    x_ohm_per_km: float = 0.3,
    max_i_ka: float = 0.2,
) -> NetworkModel:
    """Source bus, one line, one connection bus. Solvable by hand."""
    return NetworkModel(
        buses=[
            Bus(code="SS", nominal_kv=nominal_kv, kind=BusKind.SOURCE),
            Bus(code="END", nominal_kv=nominal_kv),
        ],
        lines=[
            Line(
                code="L1",
                from_bus="SS",
                to_bus="END",
                length_km=length_km,
                r_ohm_per_km=r_ohm_per_km,
                x_ohm_per_km=x_ohm_per_km,
                max_i_ka=max_i_ka,
            )
        ],
    )


def feeder_with_transformer(*, sn_mva: float = 0.25) -> NetworkModel:
    """A minimal microgrid shape: MV feeder, distribution transformer, LV bus."""
    return NetworkModel(
        buses=[
            Bus(code="SS", nominal_kv=11.0, kind=BusKind.SOURCE),
            Bus(code="F1", nominal_kv=11.0),
            Bus(code="LV", nominal_kv=0.415),
        ],
        lines=[
            Line(
                code="L1",
                from_bus="SS",
                to_bus="F1",
                length_km=2.0,
                r_ohm_per_km=0.4,
                x_ohm_per_km=0.3,
                max_i_ka=0.2,
            )
        ],
        transformers=[
            Transformer(
                code="TX1",
                hv_bus="F1",
                lv_bus="LV",
                sn_mva=sn_mva,
                vn_hv_kv=11.0,
                vn_lv_kv=0.415,
                vk_percent=4.0,
                vkr_percent=1.0,
            )
        ],
    )
