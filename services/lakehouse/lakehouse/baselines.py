"""Baselines computed from what the lake actually holds.

A diagnostic that compares a live number against a constant someone typed into a
config file is a guess wearing a threshold. These baselines are instead computed
from the Parquet objects the ingestion job wrote, and every baseline row carries:

* the objects it was computed from (`source_objects`), and
* how many rows those objects contributed (`sample_rows`).

Two refusals hold this together:

1. **A recorded object whose bytes no longer match its recorded digest aborts the
   dataset.** The lake's contents changed under us; a baseline computed from the
   remainder would be presented as history without being history.
2. **A metric whose columns are missing from the objects is skipped, not
   defaulted.** No column means no measurement — never zero.

A dataset with no verified objects in the window produces no baseline at all, and
the diagnostics surface then says "no baseline" rather than calling live values
normal or abnormal.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Sequence

from .config import Config
from .datasets import DATASETS, Dataset
from .encode import digest
from .store import Store, StoreError

logger = logging.getLogger(__name__)


class BaselineError(RuntimeError):
    """Raised when the lake cannot be trusted to compute a baseline from."""


@dataclass(frozen=True)
class Metric:
    name: str
    unit: str
    #: Columns that must be present in the object, or the metric is skipped.
    requires: tuple[str, ...]
    #: Reduce the collected column values to one number.
    compute: Callable[[dict[str, list[Any]], float], float | None]


@dataclass
class DatasetBaselines:
    dataset: str
    window_start: datetime
    window_end: datetime
    sample_rows: int
    source_objects: list[str] = field(default_factory=list)
    values: dict[str, tuple[float, str]] = field(default_factory=dict)
    skipped: dict[str, str] = field(default_factory=dict)
    #: True when a recorded object could not be read or no longer matches its
    #: digest — distinct from a window that simply had no ingestion.
    verification_failed: bool = False
    detail: str = ""


def _numbers(values: Sequence[Any]) -> list[float]:
    out: list[float] = []
    for value in values:
        if value is None:
            continue
        try:
            out.append(float(value))
        except (TypeError, ValueError):
            continue
    return out


def _rate_per_hour(column: str) -> Callable[[dict[str, list[Any]], float], float | None]:
    def compute(columns: dict[str, list[Any]], hours: float) -> float | None:
        if hours <= 0:
            return None
        return len(columns[column]) / hours

    return compute


def _mean(column: str) -> Callable[[dict[str, list[Any]], float], float | None]:
    def compute(columns: dict[str, list[Any]], _hours: float) -> float | None:
        numbers = _numbers(columns[column])
        if not numbers:
            # Every value was null: the column exists but measured nothing.
            return None
        return sum(numbers) / len(numbers)

    return compute


def _distinct(column: str) -> Callable[[dict[str, list[Any]], float], float | None]:
    def compute(columns: dict[str, list[Any]], _hours: float) -> float | None:
        return float(len({value for value in columns[column] if value is not None}))

    return compute


def _null_share(column: str) -> Callable[[dict[str, list[Any]], float], float | None]:
    def compute(columns: dict[str, list[Any]], _hours: float) -> float | None:
        values = columns[column]
        if not values:
            return None
        missing = sum(1 for value in values if value is None)
        return missing / len(values)

    return compute


#: What is worth knowing the normal shape of, per dataset. Deliberately small:
#: each of these is cited by a diagnosis, so each must be defensible.
METRICS: dict[str, tuple[Metric, ...]] = {
    "telemetry": (
        Metric("samples_per_hour", "rows/hour", ("id",), _rate_per_hour("id")),
        Metric("reporting_assets", "assets", ("assetId",), _distinct("assetId")),
        Metric("mean_power_w", "W", ("power",), _mean("power")),
        Metric("missing_power_share", "ratio", ("power",), _null_share("power")),
        Metric("missing_soc_share", "ratio", ("stateOfCharge",), _null_share("stateOfCharge")),
    ),
    "payments": (
        Metric("versions_per_hour", "rows/hour", ("id",), _rate_per_hour("id")),
        Metric("mean_amount_cents", "cents", ("amount",), _mean("amount")),
    ),
    "trades": (
        Metric("versions_per_hour", "rows/hour", ("id",), _rate_per_hour("id")),
        Metric("mean_energy_wh", "Wh", ("energy",), _mean("energy")),
    ),
    "p2p_settlements": (
        Metric("versions_per_hour", "rows/hour", ("id",), _rate_per_hour("id")),
        Metric("mean_amount_cents", "cents", ("amountCents",), _mean("amountCents")),
        Metric("mean_delivered_wh", "Wh", ("deliveredEnergyWh",), _mean("deliveredEnergyWh")),
    ),
    "settlement_events": (
        Metric("events_per_hour", "rows/hour", ("id",), _rate_per_hour("id")),
        Metric("mean_net_amount", "cents", ("net_amount",), _mean("net_amount")),
    ),
    "event_inbox": (
        Metric("consumed_per_hour", "rows/hour", ("id",), _rate_per_hour("id")),
        Metric("distinct_topics", "topics", ("topic",), _distinct("topic")),
    ),
}


def _read_parquet(body: bytes) -> dict[str, list[Any]]:
    import pyarrow.parquet as pq  # noqa: PLC0415 - heavy import, only needed here

    table = pq.read_table(io.BytesIO(body))
    return {name: table.column(name).to_pylist() for name in table.column_names}


def verified_objects(
    connection: Any, dataset: Dataset, window_start: datetime, window_end: datetime
) -> list[tuple[str, str, int]]:
    """Objects a succeeded run recorded in the window, as (key, digest, rows)."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT object_key, object_digest, rows_written
              FROM lakehouse_runs
             WHERE dataset = %s AND state = 'succeeded'
               AND finished_at >= %s AND finished_at < %s
             ORDER BY id
            """,
            (dataset.name, window_start, window_end),
        )
        return [(row[0], row[1], int(row[2])) for row in cursor.fetchall()]


def compute_dataset_baselines(
    connection: Any,
    store: Store,
    dataset: Dataset,
    window_start: datetime,
    window_end: datetime,
) -> DatasetBaselines:
    objects = verified_objects(connection, dataset, window_start, window_end)
    result = DatasetBaselines(
        dataset=dataset.name,
        window_start=window_start,
        window_end=window_end,
        sample_rows=0,
    )
    if not objects:
        result.detail = (
            f"No succeeded ingestion run for {dataset.name} between {window_start.isoformat()} "
            f"and {window_end.isoformat()}, so there is nothing to compute a baseline from."
        )
        return result

    columns: dict[str, list[Any]] = {}
    for key, recorded_digest, _rows in objects:
        try:
            body = store.get(key)
        except StoreError as exc:
            raise BaselineError(
                f"{dataset.name}: object {key} recorded by a succeeded run cannot be read "
                f"({exc}); a baseline from the remaining objects would not be this window's history"
            ) from exc

        actual = digest(body)
        if actual != recorded_digest:
            raise BaselineError(
                f"{dataset.name}: object {key} now digests to {actual} but the run recorded "
                f"{recorded_digest}; the lake changed under this baseline"
            )

        for name, values in _read_parquet(body).items():
            columns.setdefault(name, []).extend(values)
        result.source_objects.append(key)

    result.sample_rows = len(columns.get("_row_id", columns.get("id", [])))
    hours = (window_end - window_start).total_seconds() / 3600.0

    for metric in METRICS.get(dataset.name, ()):
        missing = [column for column in metric.requires if column not in columns]
        if missing:
            result.skipped[metric.name] = f"columns absent from the objects: {', '.join(missing)}"
            continue
        value = metric.compute(columns, hours)
        if value is None:
            result.skipped[metric.name] = "no non-null values in the window"
            continue
        result.values[metric.name] = (float(value), metric.unit)

    result.detail = (
        f"{dataset.name}: {len(result.values)} metric(s) from {result.sample_rows} rows across "
        f"{len(result.source_objects)} verified object(s)"
    )
    return result


def store_baselines(connection: Any, result: DatasetBaselines, runner: str) -> int:
    """Persist the computed metrics. Nothing is written for a dataset with no rows:
    a baseline row with no sample is rejected by the table's own constraint."""
    if result.sample_rows <= 0 or not result.source_objects:
        return 0
    written = 0
    with connection.cursor() as cursor:
        for metric, (value, unit) in result.values.items():
            cursor.execute(
                """
                INSERT INTO lakehouse_baselines
                  (dataset, metric, unit, window_start, window_end, value, sample_rows,
                   source_objects, runner)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (dataset, metric, window_start, window_end) DO UPDATE
                   SET value = EXCLUDED.value,
                       unit = EXCLUDED.unit,
                       sample_rows = EXCLUDED.sample_rows,
                       source_objects = EXCLUDED.source_objects,
                       computed_at = now(),
                       runner = EXCLUDED.runner
                """,
                (
                    result.dataset,
                    metric,
                    unit,
                    result.window_start,
                    result.window_end,
                    value,
                    result.sample_rows,
                    result.source_objects,
                    runner,
                ),
            )
            written += 1
    connection.commit()
    return written


def run(
    connection: Any,
    store: Store,
    config: Config,
    *,
    datasets: Sequence[Dataset] = DATASETS,
    window_hours: int = 24,
    now: datetime | None = None,
) -> list[DatasetBaselines]:
    end = now or datetime.now(timezone.utc).replace(tzinfo=None)
    start = end - timedelta(hours=window_hours)
    results: list[DatasetBaselines] = []
    for dataset in datasets:
        try:
            result = compute_dataset_baselines(connection, store, dataset, start, end)
        except BaselineError as exc:
            # One dataset's corrupted object must not silence the others, but the
            # failure is logged verbatim and nothing is written for that dataset.
            logger.error("%s", exc)
            failed = DatasetBaselines(
                dataset=dataset.name,
                window_start=start,
                window_end=end,
                sample_rows=0,
                verification_failed=True,
                detail=str(exc),
            )
            results.append(failed)
            continue
        store_baselines(connection, result, config.runner)
        logger.info("%s", result.detail)
        results.append(result)
    return results


def main(argv: Sequence[str] | None = None) -> int:
    """`python -m lakehouse.baselines`. Exits non-zero when any dataset's objects
    could not be verified, so a CronJob shows the failure."""
    import argparse  # noqa: PLC0415

    import psycopg2  # noqa: PLC0415

    from .config import ConfigError, load_config  # noqa: PLC0415
    from .datasets import selected  # noqa: PLC0415
    from .store import open_store  # noqa: PLC0415

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    parser = argparse.ArgumentParser(prog="lakehouse.baselines", description=__doc__)
    parser.add_argument("--datasets", nargs="*", default=[])
    parser.add_argument("--window-hours", type=int, default=24)
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        config = load_config()
        datasets = selected(args.datasets)
    except (ConfigError, KeyError) as exc:
        logger.error("%s", exc)
        return 2

    store = open_store(config.store)
    connection = psycopg2.connect(config.dsn)
    try:
        results = run(
            connection, store, config, datasets=datasets, window_hours=args.window_hours
        )
    finally:
        connection.close()

    # A window with no ingestion is not a failure; an unreadable or changed object is.
    return 1 if any(result.verification_failed for result in results) else 0


if __name__ == "__main__":  # pragma: no cover - exercised via the CLI
    raise SystemExit(main())
