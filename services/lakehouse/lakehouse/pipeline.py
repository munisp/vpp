"""The ingestion job itself: incremental, resumable, and honest about failure.

The ordering of the four steps in `_ingest_batch` is the whole design:

1. read the dataset's watermark,
2. read the rows past it,
3. put the object and read it back,
4. only then, in one transaction, record the run and advance the watermark.

That order gives at-least-once ingestion. A crash between 3 and 4 re-reads the
same rows next time and writes them to the *same key* (the key contains the id
range and the content digest), so the replay overwrites rather than duplicates. A
failure in 3 leaves the watermark where it was and records a run whose `error` is
the store's own message. What cannot happen is the previous pipeline's failure
mode: a hole in the lake that no query can find, behind a log line saying the ETL
completed successfully.

Concurrency is a Postgres advisory lock per dataset. Two schedulers, or a cron
run overlapping a slow previous one, do not both extract the same window: the
second sees the lock held and reports the dataset as skipped rather than writing a
second object for the same rows.
"""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

import psycopg2
import psycopg2.extras

from .config import Config
from .datasets import Dataset
from .encode import digest as content_digest, to_parquet
from .store import Store, StoreError

logger = logging.getLogger(__name__)

#: Namespace for the per-dataset advisory lock, so these locks cannot collide
#: with another feature's advisory locks in the same database.
LOCK_NAMESPACE = 0x4C48  # 'LH'


@dataclass(frozen=True)
class Watermark:
    at: Optional[dt.datetime]
    row_id: Optional[int]

    @property
    def resumable(self) -> bool:
        return self.at is not None and self.row_id is not None


@dataclass
class DatasetResult:
    dataset: str
    #: 'succeeded' | 'empty' | 'failed' | 'skipped_locked'
    state: str
    batches: int = 0
    rows: int = 0
    bytes_written: int = 0
    objects: list[str] = field(default_factory=list)
    error: Optional[str] = None


def _lock_key(dataset: str) -> int:
    # Stable, database-independent: hashtext() is not portable across versions.
    return int.from_bytes(dataset.encode("utf-8")[:4].ljust(4, b"\0"), "big")


def _read_watermark(cursor: Any, dataset: str) -> Watermark:
    cursor.execute(
        """
        INSERT INTO lakehouse_watermarks (dataset) VALUES (%s)
        ON CONFLICT (dataset) DO NOTHING
        """,
        (dataset,),
    )
    cursor.execute(
        'SELECT watermark_at, watermark_id FROM lakehouse_watermarks WHERE dataset = %s',
        (dataset,),
    )
    row = cursor.fetchone()
    return Watermark(at=row[0], row_id=row[1])


def _object_key(dataset: Dataset, rows: Sequence[Mapping[str, Any]], content_digest: str) -> str:
    """Partitioned by the change time of the batch's first row, named by the id
    range it covers, so a replay of the same rows lands on the same object."""
    first = rows[0]["_change_at"]
    partition = first.strftime("%Y-%m-%d") if isinstance(first, dt.datetime) else "unknown"
    return (
        f"{dataset.name}/change_date={partition}/"
        f"{dataset.name}-{rows[0]['_row_id']}-{rows[-1]['_row_id']}-{content_digest[:12]}.parquet"
    )


def _start_run(
    connection: Any, dataset: Dataset, runner: str, watermark: Watermark
) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO lakehouse_runs
              (dataset, state, runner, from_watermark_at, from_watermark_id)
            VALUES (%s, 'running', %s, %s, %s)
            RETURNING id
            """,
            (dataset.name, runner, watermark.at, watermark.row_id),
        )
        run_id = int(cursor.fetchone()[0])
    connection.commit()
    return run_id


def _fail_run(connection: Any, run_id: int, message: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE lakehouse_runs
               SET state = 'failed', finished_at = now(), error = %s
             WHERE id = %s
            """,
            (message[:2000], run_id),
        )
    connection.commit()


def _ingest_batch(
    connection: Any,
    store: Store,
    dataset: Dataset,
    config: Config,
) -> tuple[str, int, int, Optional[str]]:
    """One batch. Returns (state, rows, bytes, object key)."""
    with connection.cursor() as cursor:
        watermark = _read_watermark(cursor, dataset.name)
    connection.commit()

    run_id = _start_run(connection, dataset, config.runner, watermark)

    try:
        with connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
            if watermark.resumable:
                cursor.execute(
                    dataset.select_sql(resume=True),
                    (watermark.at, watermark.row_id, config.batch_rows),
                )
            else:
                cursor.execute(dataset.select_sql(resume=False), (config.batch_rows,))
            rows = [dict(row) for row in cursor.fetchall()]
        connection.commit()
    except psycopg2.Error as exc:
        connection.rollback()
        _fail_run(connection, run_id, f"extract: {exc}")
        raise

    if not rows:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE lakehouse_runs SET state = 'empty', finished_at = now() WHERE id = %s",
                (run_id,),
            )
        connection.commit()
        return ("empty", 0, 0, None)

    body = to_parquet(rows)
    key = _object_key(dataset, rows, content_digest(body))

    try:
        stored = store.put(key, body)
    except StoreError as exc:
        _fail_run(connection, run_id, str(exc))
        raise

    last = rows[-1]
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE lakehouse_runs
                   SET state = 'succeeded', finished_at = now(), rows_written = %s,
                       bytes_written = %s, object_key = %s, object_digest = %s,
                       to_watermark_at = %s, to_watermark_id = %s
                 WHERE id = %s
                """,
                (
                    len(rows),
                    stored.bytes_written,
                    stored.key,
                    stored.digest,
                    last["_change_at"],
                    last["_row_id"],
                    run_id,
                ),
            )
            cursor.execute(
                """
                UPDATE lakehouse_watermarks
                   SET watermark_at = %s, watermark_id = %s,
                       rows_ingested = rows_ingested + %s, updated_at = now()
                 WHERE dataset = %s
                """,
                (last["_change_at"], last["_row_id"], len(rows), dataset.name),
            )
        connection.commit()
    except psycopg2.Error as exc:
        connection.rollback()
        # The object is in the store but the watermark did not move. The next run
        # re-reads these rows and overwrites the same key, so the lake stays
        # correct; the run is recorded as failed because this one did not finish.
        _fail_run(connection, run_id, f"commit: {exc}")
        raise

    return ("succeeded", len(rows), stored.bytes_written, stored.key)


def ingest_dataset(
    connection: Any,
    store: Store,
    dataset: Dataset,
    config: Config,
    max_batches: int = 20,
) -> DatasetResult:
    result = DatasetResult(dataset=dataset.name, state="empty")

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_try_advisory_lock(%s, %s)", (LOCK_NAMESPACE, _lock_key(dataset.name))
        )
        acquired = bool(cursor.fetchone()[0])
    connection.commit()
    if not acquired:
        logger.warning(
            "%s is already being ingested by another runner; skipping this pass", dataset.name
        )
        return DatasetResult(dataset=dataset.name, state="skipped_locked")

    try:
        for _ in range(max_batches):
            try:
                state, rows, written, key = _ingest_batch(connection, store, dataset, config)
            except (psycopg2.Error, StoreError, ValueError) as exc:
                result.state = "failed"
                result.error = str(exc)
                logger.error("%s ingestion failed: %s", dataset.name, exc)
                break

            if state == "empty":
                break

            result.batches += 1
            result.rows += rows
            result.bytes_written += written
            result.state = "succeeded"
            if key:
                result.objects.append(key)

            if rows < config.batch_rows:
                break
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_unlock(%s, %s)", (LOCK_NAMESPACE, _lock_key(dataset.name))
            )
        connection.commit()

    return result


def run(
    config: Config,
    store: Store,
    datasets: Sequence[Dataset],
    max_batches: int = 20,
) -> list[DatasetResult]:
    connection = psycopg2.connect(config.dsn)
    try:
        return [
            ingest_dataset(connection, store, dataset, config, max_batches)
            for dataset in datasets
        ]
    finally:
        connection.close()
