# Lakehouse ingestion

Incremental, resumable extraction of platform tables from PostgreSQL into an
object store as Parquet.

PostgreSQL stays the relational source of truth. This job copies rows out of it so
analytics, training and reporting read a columnar snapshot instead of competing
with production traffic — and it records what it copied, so nobody has to assume.

## What it will not do

The predecessor (`services/lakehouse/etl_pipeline.py`, removed) logged
`ETL completed successfully` regardless of whether the load worked: it ignored the
return value of its own write step. The rules here exist to make that impossible.

- **A run is `succeeded` only after the object was read back out of the store and
  its SHA-256 matched what was written.** An accepted `PUT` is not evidence.
- **Watermarks advance only after that verification and after the bookkeeping
  commits.** A failed run leaves the watermark where it was, so rows are re-read
  rather than skipped.
- **A failure records the exact database or object-store error** in
  `lakehouse_runs.error`, with `state='failed'` and a finish time.
- **An empty run is `empty`, not `succeeded`.** "Nothing new" is not a load, and
  the encoder refuses to write an empty Parquet batch at all.
- **The CLI exits non-zero if any dataset fails**, so a scheduler surfaces it.
- **No implicit local store.** In production, the store must be named: `s3`
  requires a bucket and credentials, and a local filesystem store must be asked
  for explicitly with `LAKEHOUSE_STORE=file`.

## Datasets

| Dataset | Source table | Watermark | Shape |
| --- | --- | --- | --- |
| `telemetry` | `telemetry` | `createdAt`, `id` | append-only, in receipt order |
| `payments` | `payments` | `updatedAt`, `id` | versioned: one row per change |
| `trades` | `trades` | `updatedAt`, `id` | versioned |
| `p2p_settlements` | `p2p_settlements` | `updatedAt`, `id` | versioned |
| `settlement_events` | `settlement_events` | `created_at`, `id` | append-only, hash-chained |
| `event_inbox` | `event_inbox` | `consumed_at`, `id` | append-only |

Each dataset lists its columns explicitly — no `SELECT *`, so a new production
column never lands in the lake unreviewed. Subscriber contact details and account
numbers (`phoneNumber`, `accountNumber`) are deliberately excluded from the payment
projection.

Mutable tables are ingested as *versions*: a payment that changes state three times
appears three times, and the reader picks the latest per `id`. That keeps ingestion
append-only, which is what makes it resumable.

### Where Kafka fits

The `event_inbox` dataset is the boundary with the event stream. This job does not
consume Kafka. The platform's own consumer (`server/services/events/consumer.ts`)
writes every consumed message into `event_inbox` inside a transaction, and this job
ingests that table like any other. So the lake sees exactly the events the platform
processed — not a second, independently-lagging Kafka reader whose offsets nobody
reconciles.

## Running it

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

export LAKEHOUSE_DATABASE_URL=postgres://vpp:vpp@127.0.0.1:5432/vpp
export LAKEHOUSE_STORE=file
export LAKEHOUSE_LOCAL_PATH=/var/lib/vpp/lake

python -m lakehouse                       # every dataset, once
python -m lakehouse --datasets telemetry  # one dataset
python -m lakehouse --loop-seconds 300    # keep going, 5 minutes apart
python -m lakehouse --max-batches 40      # bound one pass
```

Concurrent runners are safe: each dataset is claimed with a PostgreSQL advisory
lock, and a runner that cannot take the lock skips that dataset instead of
extracting it twice.

### Configuration

| Variable | Meaning |
| --- | --- |
| `LAKEHOUSE_DATABASE_URL` | Source DSN; falls back to `DATABASE_URL`. |
| `LAKEHOUSE_STORE` | `s3` (default) or `file`. |
| `LAKEHOUSE_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Required for `s3`. |
| `S3_ENDPOINT`, `S3_REGION` | For MinIO or a non-AWS endpoint. |
| `LAKEHOUSE_LOCAL_PATH` | Required for `file`. |
| `LAKEHOUSE_PREFIX` | Key prefix; default `raw`. |
| `LAKEHOUSE_BATCH_ROWS` | Rows per object; default 10000. |
| `LAKEHOUSE_FRESHNESS_SECONDS` | Freshness budget the API reports against. |
| `LAKEHOUSE_RUNNER` | Recorded on each run so runners are distinguishable. |

## Tests

```bash
pip install -r requirements-dev.txt
pytest                                    # unit tests, no database needed

export LAKEHOUSE_TEST_DSN=postgres://vpp:vpp@127.0.0.1:5432/vpp_lake
pytest                                    # adds the real-PostgreSQL pipeline tests
```

The PostgreSQL tests require `LAKEHOUSE_TEST_DSN`; without it they are skipped and
say so, rather than passing as if they had exercised a database.

## What an operator sees

`/admin/lakehouse` in the web console and the `Lakehouse` screen in the mobile app
read `lakehouse_runs` and `lakehouse_watermarks` (migration
`0015_lakehouse_ingestion`). A dataset that has never been ingested reads
`never ingested`; a dataset whose last run failed shows this job's own error; and
backlog is counted against the source table, reported as `unknown` when the source
cannot be counted rather than as zero.
