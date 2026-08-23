# The ingestion job runs as a CronJob (see
# infrastructure/k8s/ha/lakehouse-ingest-cronjob.yaml)
# and exits non-zero when a dataset fails, so a broken pipeline shows up as a
# failed job rather than as a quiet lake.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY lakehouse ./lakehouse

# Parquet encoding is not optional; without pyarrow the job would have to fall
# back to a format nothing in the read path understands.
RUN python -c "import pyarrow.parquet"  # noqa

ENTRYPOINT ["python", "-m", "lakehouse"]
