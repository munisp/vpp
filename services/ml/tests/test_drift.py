import numpy as np
import pytest

from vppml import drift, features


NAMES = ("power_norm", "soc_fraction")


def sample(mean: float, count: int = 2000, spread: float = 0.1) -> np.ndarray:
    rng = np.random.default_rng(4)
    first = rng.normal(mean, spread, count)
    second = rng.normal(0.5, 0.1, count)
    return np.stack([first, second], axis=1).reshape(count, 1, 2).astype("float32")


def baselines(mean: float = 0.3) -> dict[str, dict]:
    """Baselines exactly as a training run stores them: from the training tensor."""
    return features.feature_statistics(sample(mean), NAMES)


def test_a_missing_baseline_is_not_reported_as_no_drift():
    """The bug this replaces: an absent baseline used to be written from the current
    window and reported as calm."""
    report = drift.compare({}, sample(0.3), NAMES)
    assert report.state == "no_baseline"
    assert report.severity == "unknown"
    assert "cannot be measured" in report.detail


def test_an_empty_window_is_unmeasured_not_zero():
    report = drift.compare(baselines(), np.empty((0, 1, 2), dtype="float32"), NAMES)
    assert report.state == "insufficient_data"
    assert "not zero" in report.detail


def test_too_few_observations_is_unmeasured():
    report = drift.compare(baselines(), sample(0.3, count=10), NAMES)
    assert report.state == "insufficient_data"
    assert report.samples == 10


def test_the_same_distribution_measures_as_no_drift():
    report = drift.compare(baselines(), sample(0.3), NAMES)
    assert report.state == "measured"
    assert report.severity == "none"
    assert report.drifted == []


def test_a_shifted_distribution_is_flagged_severe_with_the_feature_named():
    report = drift.compare(baselines(0.3), sample(0.9), NAMES)
    assert report.state == "measured"
    assert report.severity == "severe"
    assert [item.feature for item in report.drifted] == ["power_norm"]
    drifted = report.drifted[0]
    assert drifted.psi > drift.PSI_SEVERE or drifted.mean_shift >= drift.SHIFT_SEVERE
    assert drifted.current_mean > drifted.baseline_mean


def test_a_baseline_from_a_different_feature_set_is_incomparable_not_clean():
    report = drift.compare({"legacy_feature": {"mean": 0.0, "std": 1.0, "bin_edges": [0.0, 1.0], "bin_shares": [1.0]}}, sample(0.3), NAMES)
    assert report.state == "no_baseline"
    assert "feature contract changed" in report.detail


def test_psi_needs_matching_bins():
    with pytest.raises(ValueError, match="same binning"):
        drift.population_stability_index([0.5, 0.5], [1.0])


def test_psi_is_zero_for_an_identical_histogram_and_positive_otherwise():
    assert drift.population_stability_index([0.5, 0.5], [0.5, 0.5]) == pytest.approx(0.0)
    assert drift.population_stability_index([0.5, 0.5], [0.9, 0.1]) > drift.PSI_SEVERE


def test_values_outside_the_baseline_range_count_as_drift_rather_than_being_dropped():
    report = drift.compare(baselines(0.3), sample(50.0), NAMES)
    assert report.state == "measured"
    assert report.severity == "severe"


class FakeCursor:
    def __init__(self, row):
        self._row = row

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, *args):
        return None

    def fetchone(self):
        return self._row


class FakeConnection:
    def __init__(self, row):
        self._row = row

    def cursor(self):
        return FakeCursor(self._row)


def test_predictions_with_no_actuals_leave_live_accuracy_unknown():
    check = drift.performance_since_deploy(FakeConnection((None, 0)), 1, baseline_mae=100.0)
    assert check.state == "no_actuals"
    assert check.degraded is False


def test_live_error_close_to_validation_error_is_not_degradation():
    check = drift.performance_since_deploy(FakeConnection((110.0, 500)), 1, baseline_mae=100.0)
    assert check.state == "measured"
    assert check.degraded is False
    assert check.ratio == pytest.approx(1.1)


def test_live_error_well_above_validation_error_is_degradation():
    check = drift.performance_since_deploy(FakeConnection((260.0, 500)), 1, baseline_mae=100.0)
    assert check.degraded is True
    assert "260.0" in check.detail


def test_without_a_validation_baseline_live_error_is_reported_but_not_judged():
    check = drift.performance_since_deploy(FakeConnection((260.0, 500)), 1, baseline_mae=None)
    assert check.state == "measured"
    assert check.degraded is False
    assert "no validation" in check.detail
