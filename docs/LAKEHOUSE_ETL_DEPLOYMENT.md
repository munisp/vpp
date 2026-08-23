# Lakehouse Ingestion Deployment Guide

## What this document used to say

Until now this guide described a Kafka → Apache Iceberg pipeline
(`server/integration/lakehouse-etl.py`) that required a Hive metastore, a Trino
cluster and a `pyiceberg` catalog. That pipeline was never deployed, was not
started by anything, and its predecessor in `services/lakehouse/etl_pipeline.py`
reported `ETL completed successfully` while ignoring the return value of its own
load step — so a failed write logged a success. Both are removed.

What is deployed instead is a PostgreSQL → object store ingestion job
(`services/lakehouse/`) that copies platform tables to Parquet incrementally, and
records what it actually stored. This guide covers that job.

The MinIO / Hive / Trino stack in `infrastructure/k8s/ha/lakehouse-ha.yaml` is the
storage and query side and is unchanged; the Parquet objects this job writes are
what gives it something to read.

## Architecture

```
PostgreSQL (source of truth)
   │  explicit column projections, (change_column, id) watermarks
   ▼
services/lakehouse  ──▶  Parquet object  ──▶  read back, SHA-256 compared
   │                                              │
   │                                              ▼
   │                                        object store (S3/MinIO, or a local
   │                                        filesystem when asked for explicitly)
   ▼
lakehouse_runs + lakehouse_watermarks (migration 0015)
   ▼
/admin/lakehouse (web) · Lakehouse screen (mobile) · trpc `lakehouse.status`
```

Kafka is *not* read by this job. The platform's own consumer writes each consumed
message into `event_inbox` in a transaction, and the `event_inbox` dataset ingests
that table — so the lake reflects the events the platform processed rather than a
second Kafka reader with its own unreconciled offsets.

## Prerequisites

- PostgreSQL 14+ reachable from wherever the job runs, with the platform schema
  migrated at least to `0015_lakehouse_ingestion`.
- Python 3.11+ (the image is 3.12).
- An object store: S3 or MinIO (`LAKEHOUSE_STORE=s3`), or a filesystem path when
  explicitly configured with `LAKEHOUSE_STORE=file`.

There is no implicit default store. A misconfigured deployment refuses to run
instead of quietly writing to a local directory nothing reads.

## Step 1: Apply the migration

```bash
psql "$DATABASE_URL" -f drizzle/migrations/0015_lakehouse_ingestion.sql
```

This creates `lakehouse_watermarks` and `lakehouse_runs`, plus the constraints that
keep run records honest: a `succeeded` run must name an object and a digest, a
`failed` run must carry an error and a finish time, and an `empty` run must have no
object and zero rows.

## Step 2: Database role

Extraction needs `SELECT` on the source tables; bookkeeping needs write access to
the two `lakehouse_*` tables and the ability to take advisory locks.

```sql
CREATE ROLE vpp_lakehouse LOGIN PASSWORD '<secret>';
GRANT CONNECT ON DATABASE vpp TO vpp_lakehouse;
GRANT USAGE ON SCHEMA public TO vpp_lakehouse;
GRANT SELECT ON telemetry, payments, trades, p2p_settlements,
                settlement_events, event_inbox TO vpp_lakehouse;
GRANT SELECT, INSERT, UPDATE ON lakehouse_runs, lakehouse_watermarks TO vpp_lakehouse;
GRANT USAGE, SELECT ON SEQUENCE lakehouse_runs_id_seq TO vpp_lakehouse;
```

Payment contact details are excluded by the dataset projection, not by this grant —
`phoneNumber` and `accountNumber` never leave PostgreSQL.

## Step 3: Configure

```bash
# Source
LAKEHOUSE_DATABASE_URL=postgres://vpp_lakehouse:<secret>@postgres:5432/vpp

# Destination (S3 or MinIO)
LAKEHOUSE_STORE=s3
LAKEHOUSE_BUCKET=vpp-lakehouse
LAKEHOUSE_PREFIX=raw
S3_ENDPOINT=http://minio.lakehouse.svc.cluster.local:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=<minio-access-key>
S3_SECRET_KEY=<minio-secret-key>

# Behaviour
LAKEHOUSE_BATCH_ROWS=20000
LAKEHOUSE_FRESHNESS_SECONDS=3600
LAKEHOUSE_RUNNER=k8s-cronjob
```

`LAKEHOUSE_FRESHNESS_SECONDS` must match the value the API process sees, or the
console will call a dataset stale that the schedule considers on time.

For a filesystem target (single-node or an evaluation deployment) the store has to
be named explicitly:

```bash
LAKEHOUSE_STORE=file
LAKEHOUSE_LOCAL_PATH=/var/lib/vpp/lake
```

## Step 4: Run it

```bash
cd services/lakehouse
pip install -r requirements.txt
python -m lakehouse                        # one pass over every dataset
python -m lakehouse --datasets telemetry payments
python -m lakehouse --loop-seconds 300     # long-running mode
python -m lakehouse --max-batches 40       # bound a single pass
```

Exit status is the deployment signal: non-zero when any dataset failed. Datasets
that found nothing log `empty` and are not counted as loads.

Backfilling a large table is just repeated running: each pass moves the watermark
forward by up to `--max-batches × LAKEHOUSE_BATCH_ROWS` rows and can be interrupted
at any point without losing or duplicating rows.

## Step 5: Schedule it

```bash
kubectl apply -f infrastructure/k8s/ha/lakehouse-ingest-cronjob.yaml
```

The CronJob runs every 15 minutes with `concurrencyPolicy: Forbid`, keeps failed
jobs in history, and passes credentials from the `lakehouse-ingest-credentials` and
`minio-credentials` secrets. Concurrency is safe regardless: each dataset is claimed
with a PostgreSQL advisory lock, and a runner that cannot take the lock skips the
dataset rather than extracting it twice.

Docker, if you are not on Kubernetes:

```bash
docker build -t vpp-lakehouse-ingest services/lakehouse
docker run --rm --env-file lakehouse.env vpp-lakehouse-ingest --max-batches 40
```

## Step 6: Verify — and what counts as verification

```bash
# What the job recorded
psql "$DATABASE_URL" -c "SELECT dataset, state, rows_written, object_key, error
                           FROM lakehouse_runs ORDER BY id DESC LIMIT 10;"

# How far each dataset has been ingested
psql "$DATABASE_URL" -c "SELECT dataset, watermark_at, watermark_id, rows_ingested
                           FROM lakehouse_watermarks ORDER BY dataset;"
```

A `succeeded` row means the object was written, read back, and its SHA-256 matched.
That is the only claim the job makes; it does not assert that a query engine has
registered the object or that a downstream table sees it.

In the console, `/admin/lakehouse` shows per-dataset state (`ingesting`, `stale`,
`failing`, `never ingested`), the backlog counted against each source table, and
the object key behind the newest successful run. `trpc lakehouse.status` and
`lakehouse.runs` back both that page and the mobile screen.

## Failure modes and what they look like

| What happened | What you see |
| --- | --- |
| Object store refuses the write | `state='failed'` with the store's error; watermark unchanged |
| Object reads back with a different digest | `state='failed'` with expected vs actual digest; nothing recorded as ingested |
| Job killed mid-run | the `running` row is left behind; the watermark did not move, so the next run re-reads the same rows |
| No new rows | `state='empty'`, no object, zero rows — not a success |
| Two runners at once | one ingests, the other skips that dataset (advisory lock) |
| Job not scheduled at all | datasets report `never ingested` / `stale` in the console; queries are not silently answered from an empty lake |

## Retention

Objects are keyed `<prefix>/<dataset>/dt=<YYYY-MM-DD>/<watermark>-<digest>.parquet`,
so lifecycle rules can expire by date prefix. Deleting objects does **not** rewind
watermarks: re-ingesting a deleted range means resetting that dataset's row in
`lakehouse_watermarks` deliberately.

## Tests

```bash
cd services/lakehouse
pip install -r requirements-dev.txt
pytest                                   # unit tests: encoding, store, config

export LAKEHOUSE_TEST_DSN=postgres://vpp:vpp@127.0.0.1:5432/vpp_lake
pytest                                   # adds real-PostgreSQL pipeline tests
```

Without `LAKEHOUSE_TEST_DSN` the pipeline tests are skipped and say so, rather than
reporting a pass without having touched a database. CI runs both the unit tests and,
against a PostgreSQL service container, the pipeline tests.
