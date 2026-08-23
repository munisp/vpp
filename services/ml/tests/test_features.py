from datetime import datetime, timedelta

import pytest

from vppml import features, synthetic
from vppml.features import FeatureSpec


SPEC = FeatureSpec(lookback=4, horizon=2, interval_minutes=15)
START = datetime(2026, 3, 2, 0, 0, 0)


def series(count: int, *, asset_id: int = 1, gap_at: int | None = None, power=None):
    columns: dict[str, list] = {
        "assetId": [],
        "timestamp": [],
        "power": [],
        "energy": [],
        "stateOfCharge": [],
    }
    step = 0
    for index in range(count):
        if gap_at is not None and index == gap_at:
            step += 1  # skip an interval: the series is no longer contiguous
        columns["assetId"].append(asset_id)
        columns["timestamp"].append(START + timedelta(minutes=15 * step))
        columns["power"].append(index * 10 if power is None else power[index])
        columns["energy"].append(index * 100)
        columns["stateOfCharge"].append(None)
        step += 1
    return columns


def build(columns, capacity=1000, kind="solar"):
    return features.build_sequences(
        columns, SPEC, asset_kinds={1: kind}, asset_capacities={1: capacity}
    )


def test_a_gap_drops_the_window_rather_than_filling_it():
    """An outage must not become a flat load the model learns to predict."""
    whole = build(series(12))
    gapped = build(series(12, gap_at=6))
    assert len(whole) == 7
    assert len(gapped) < len(whole)
    assert gapped.skipped_gaps > 0


def test_a_row_with_no_power_is_not_a_zero():
    columns = series(12)
    columns["power"][5] = None
    result = build(columns)
    assert result.skipped_gaps > 0
    assert len(result) < 7


def test_a_missing_state_of_charge_is_flagged_not_defaulted():
    columns = series(8)
    columns["stateOfCharge"] = [None] * 8
    result = build(columns)
    soc_index = features.FEATURE_NAMES.index("soc_fraction")
    present_index = features.FEATURE_NAMES.index("soc_present")
    assert float(result.x[:, :, present_index].max()) == 0.0
    assert float(result.x[:, :, soc_index].max()) == 0.0


def test_state_of_charge_is_carried_as_a_fraction_when_present():
    columns = series(8)
    columns["stateOfCharge"] = [50] * 8
    result = build(columns, kind="battery")
    soc_index = features.FEATURE_NAMES.index("soc_fraction")
    present_index = features.FEATURE_NAMES.index("soc_present")
    assert float(result.x[0, 0, soc_index]) == pytest.approx(0.5)
    assert float(result.x[0, 0, present_index]) == 1.0


def test_an_asset_with_no_capacity_is_excluded_rather_than_normalised_by_one():
    result = build(series(12), capacity=0)
    assert len(result) == 0
    assert result.rows_read == 12


def test_duplicate_instants_are_collapsed_not_treated_as_two_intervals():
    columns = series(8)
    columns["assetId"].append(1)
    columns["timestamp"].append(columns["timestamp"][3])
    columns["power"].append(999)
    columns["energy"].append(999)
    columns["stateOfCharge"].append(None)
    result = build(columns)
    assert result.rows_read == 8
    assert len(result) == 3


def test_power_is_normalised_by_capacity_and_the_scale_reads_it_back():
    columns = series(8, power=[500] * 8)
    result = build(columns, capacity=1000)
    power_index = features.FEATURE_NAMES.index("power_norm")
    assert float(result.x[0, 0, power_index]) == pytest.approx(0.5)
    assert float(result.scale[0]) == 1000.0
    assert float(result.y[0, 0]) == pytest.approx(0.5)


def test_the_split_puts_every_validation_target_after_every_training_target():
    fleet = synthetic.build_fleet(3, solar_sites=2, battery_sites=1, meter_sites=1)
    columns = synthetic.generate(fleet, start=START, hours=96)
    sequences = features.build_sequences(
        columns,
        FeatureSpec(lookback=8, horizon=2, interval_minutes=15),
        asset_kinds=synthetic.asset_kinds(fleet),
        asset_capacities=synthetic.asset_capacities(fleet),
    )
    x_train, _, x_val, _, split_at = features.time_split(sequences)
    assert len(x_train) > 0 and len(x_val) > 0
    boundary = sequences.target_at[len(x_train)]
    assert split_at == boundary
    assert all(at <= boundary for at in sequences.target_at[: len(x_train)])
    assert all(at >= boundary for at in sequences.target_at[len(x_train) :])


def test_the_feature_digest_changes_with_the_shape_it_describes():
    assert SPEC.digest() == FeatureSpec(lookback=4, horizon=2, interval_minutes=15).digest()
    assert SPEC.digest() != FeatureSpec(lookback=5, horizon=2, interval_minutes=15).digest()


def test_statistics_describe_a_constant_feature_without_dividing_by_zero():
    result = build(series(12, power=[100] * 12))
    stats = features.feature_statistics(result.x)
    constant = stats["soc_present"]
    assert constant["std"] == 0.0
    assert len(constant["bin_shares"]) == 1
    assert len(constant["bin_edges"]) == 2
    assert constant["bin_shares"][0] == 1.0


def test_missing_columns_are_reported_not_guessed():
    with pytest.raises(ValueError, match="telemetry columns missing"):
        features.build_sequences({"assetId": [1]}, SPEC, asset_kinds={}, asset_capacities={})
