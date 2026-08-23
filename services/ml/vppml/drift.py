"""Drift, measured against a stored baseline or not measured at all.

The failure mode being avoided here is specific and was present in the platform
before: the previous drift check kept its baseline in Redis and, on finding none,
*wrote the current window as the baseline and reported no drift*. Every cache
eviction therefore re-declared whatever was happening now to be normal, and drift
became undetectable precisely when the cache had restarted — which is often the
same deploy that changed the model.

So here, a missing baseline is `no_baseline`, an answer the caller has to handle,
and baselines are only ever written by a training run from the data the model was
actually fitted on.

Two signals, both reported with the sample count behind them:

* **Population stability index** over the baseline's own bin edges. Robust to
  scale, sensitive to shape, and the conventional thresholds (0.1 / 0.25) are
  used for `moderate` / `severe`.
* **Standardised mean shift**, for the case where the shape holds and the level
  moves — a re-scaled meter, a new fleet of larger batteries.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Sequence

#: PSI conventions: below 0.1 is noise, 0.1-0.25 warrants attention, above 0.25 is
#: a different population.
PSI_MODERATE = 0.1
PSI_SEVERE = 0.25
#: Standardised mean shift, in baseline standard deviations.
SHIFT_MODERATE = 0.5
SHIFT_SEVERE = 1.0
#: Below this many observations PSI is dominated by sampling noise.
MIN_SAMPLES = 200


@dataclass
class FeatureDrift:
    feature: str
    psi: float
    mean_shift: float
    baseline_mean: float
    current_mean: float
    severity: str  # 'none' | 'moderate' | 'severe'
    samples: int


@dataclass
class DriftReport:
    #: 'measured' | 'no_baseline' | 'insufficient_data'
    state: str
    features: list[FeatureDrift] = field(default_factory=list)
    detail: str = ""
    samples: int = 0

    @property
    def severity(self) -> str:
        if self.state != "measured":
            return "unknown"
        if any(item.severity == "severe" for item in self.features):
            return "severe"
        if any(item.severity == "moderate" for item in self.features):
            return "moderate"
        return "none"

    @property
    def drifted(self) -> list[FeatureDrift]:
        return [item for item in self.features if item.severity != "none"]


def population_stability_index(
    baseline_shares: Sequence[float], current_shares: Sequence[float]
) -> float:
    """PSI with a small floor on empty bins, which would otherwise be infinite."""
    import math

    if len(baseline_shares) != len(current_shares):
        raise ValueError("PSI needs the same binning on both sides")
    floor = 1e-6
    total = 0.0
    for expected, actual in zip(baseline_shares, current_shares):
        expected = max(float(expected), floor)
        actual = max(float(actual), floor)
        total += (actual - expected) * math.log(actual / expected)
    return float(total)


def _shares(values: Any, edges: Sequence[float]) -> list[float]:
    import numpy as np  # noqa: PLC0415

    # Values outside the baseline's range are counted into the edge bins rather than
    # dropped: an input the model has never seen is drift, not absence of drift.
    clipped = np.clip(values, edges[0], edges[-1])
    counts, _ = np.histogram(clipped, bins=np.asarray(edges, dtype="float64"))
    total = float(counts.sum()) or 1.0
    return [float(count) / total for count in counts]


def compare(
    baselines: dict[str, dict[str, Any]],
    current_x: Any,
    feature_names: Sequence[str],
) -> DriftReport:
    """Measure the current feature tensor against a model's stored baselines."""
    if not baselines:
        return DriftReport(
            state="no_baseline",
            detail=(
                "this model has no stored feature baseline, so drift cannot be measured. A "
                "baseline is written by the training run that produced the model; a model "
                "registered before this service existed has none."
            ),
        )
    if current_x is None or len(current_x) == 0:
        return DriftReport(
            state="insufficient_data",
            detail="no sequences in the comparison window; drift is unmeasured, not zero.",
        )

    flat = current_x.reshape(-1, current_x.shape[-1])
    samples = int(flat.shape[0])
    if samples < MIN_SAMPLES:
        return DriftReport(
            state="insufficient_data",
            samples=samples,
            detail=(
                f"{samples} observation(s) in the window is below the {MIN_SAMPLES} needed for a "
                "stable comparison; reporting unmeasured rather than a noisy PSI."
            ),
        )

    results: list[FeatureDrift] = []
    for index, name in enumerate(feature_names):
        baseline = baselines.get(name)
        if baseline is None:
            continue
        values = flat[:, index].astype("float64")
        psi = population_stability_index(baseline["bin_shares"], _shares(values, baseline["bin_edges"]))
        std = float(baseline["std"])
        current_mean = float(values.mean())
        shift = abs(current_mean - float(baseline["mean"])) / std if std > 0 else 0.0

        if psi >= PSI_SEVERE or shift >= SHIFT_SEVERE:
            severity = "severe"
        elif psi >= PSI_MODERATE or shift >= SHIFT_MODERATE:
            severity = "moderate"
        else:
            severity = "none"

        results.append(
            FeatureDrift(
                feature=name,
                psi=psi,
                mean_shift=shift,
                baseline_mean=float(baseline["mean"]),
                current_mean=current_mean,
                severity=severity,
                samples=samples,
            )
        )

    if not results:
        return DriftReport(
            state="no_baseline",
            samples=samples,
            detail=(
                "the stored baseline names none of the features being built now; the feature "
                "contract changed and the two are not comparable."
            ),
        )

    measured = DriftReport(state="measured", features=results, samples=samples)
    drifted = measured.drifted
    measured.detail = (
        f"{len(drifted)} of {len(results)} feature(s) drifted over {samples} observation(s)"
        if drifted
        else f"no feature drift over {samples} observation(s)"
    )
    return measured


@dataclass
class PerformanceCheck:
    #: 'measured' | 'no_actuals'
    state: str
    predictions: int = 0
    mae: Optional[float] = None
    baseline_mae: Optional[float] = None
    ratio: Optional[float] = None
    degraded: bool = False
    detail: str = ""


def performance_since_deploy(
    connection: Any, model_id: int, *, baseline_mae: Optional[float]
) -> PerformanceCheck:
    """Compare live error against the model's validation error.

    Only predictions whose actual has since been written count. A model whose
    predictions have no actuals yet is `no_actuals` — the platform does not know how
    it is doing, and saying so is the whole point.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT AVG(ABS(predicted_value - actual_value))::float8, COUNT(*)
              FROM model_predictions
             WHERE model_id = %s AND actual_value IS NOT NULL
            """,
            (model_id,),
        )
        row = cursor.fetchone()

    count = int(row[1] or 0) if row else 0
    if count == 0 or row[0] is None:
        return PerformanceCheck(
            state="no_actuals",
            detail=(
                "no prediction from this model has an actual recorded against it yet, so live "
                "accuracy is unknown."
            ),
        )

    mae = float(row[0])
    if baseline_mae is None or baseline_mae <= 0:
        return PerformanceCheck(
            state="measured",
            predictions=count,
            mae=mae,
            detail=(
                f"live MAE {mae:.1f} over {count} prediction(s); the model recorded no validation "
                "MAE to compare against."
            ),
        )

    ratio = mae / baseline_mae
    return PerformanceCheck(
        state="measured",
        predictions=count,
        mae=mae,
        baseline_mae=baseline_mae,
        ratio=ratio,
        degraded=ratio >= 1.5,
        detail=(
            f"live MAE {mae:.1f} vs validation {baseline_mae:.1f} ({ratio:.2f}x) over "
            f"{count} prediction(s)"
        ),
    )
