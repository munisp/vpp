"""Apache Sedona smoke job for the VPP extended stack.

Proves three things end-to-end:
  1. The Spark standalone cluster (spark://spark-master:7077) accepts jobs.
  2. The Sedona runtime registers and executes spatial SQL (ST_Point, ST_Distance).
  3. The lakehouse object store (MinIO, LAKEHOUSE_ENDPOINT/LAKEHOUSE_BUCKET,
     the same env names used by the orchestrator) is readable/writable from
     Spark via s3a by round-tripping a GeoParquet file.

Run (from repo root):
  docker compose -f docker-compose.extended.yml --profile smoke up sedona-smoke

Expected output ends with: "SEDONA_SMOKE_OK"
"""
import os
import sys

from pyspark.sql import SparkSession

LAKEHOUSE_ENDPOINT = os.environ.get("LAKEHOUSE_ENDPOINT", "http://minio:9000")
LAKEHOUSE_BUCKET = os.environ.get("LAKEHOUSE_BUCKET", "vpp-data")
LAKEHOUSE_ACCESS_KEY = os.environ.get("LAKEHOUSE_ACCESS_KEY", "minioadmin")
LAKEHOUSE_SECRET_KEY = os.environ.get("LAKEHOUSE_SECRET_KEY", "minioadmin")
MASTER = os.environ.get("SPARK_MASTER_URL", "spark://spark-master:7077")
OUT_PATH = f"s3a://{LAKEHOUSE_BUCKET}/sedona-smoke/grid-nodes.parquet"

spark = (
    SparkSession.builder.appName("sedona-smoke")
    .master(MASTER)
    # MinIO (s3a) wiring
    .config("spark.hadoop.fs.s3a.endpoint", LAKEHOUSE_ENDPOINT)
    .config("spark.hadoop.fs.s3a.access.key", LAKEHOUSE_ACCESS_KEY)
    .config("spark.hadoop.fs.s3a.secret.key", LAKEHOUSE_SECRET_KEY)
    .config("spark.hadoop.fs.s3a.path.style.access", "true")
    .config("spark.hadoop.fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem")
    .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false")
    .getOrCreate()
)

# Register Sedona without the python pip package: call the JVM entrypoint
# directly (the sedona-spark-shaded jar is on the classpath via --packages).
sedona = spark._jvm.org.apache.sedona.spark.SedonaContext.create(spark._jsparkSession)  # noqa: F841

# 1) Spatial SQL: distance between two DER sites in meters (Web-Mercator).
spark.sql(
    """
    SELECT ST_Distance(
             ST_Transform(ST_Point(28.0473, -26.2041), 'EPSG:4326', 'EPSG:3857'),
             ST_Transform(ST_Point(28.0573, -26.1941), 'EPSG:4326', 'EPSG:3857')
           ) AS dist_m
    """
).createOrReplaceTempView("distances")
dist = spark.sql("SELECT dist_m FROM distances").first()["dist_m"]
assert 1000.0 < dist < 3000.0, f"unexpected distance {dist}"
print(f"[smoke] ST_Distance between two points: {dist:.1f} m")

# 2) GeoParquet round-trip to the lakehouse bucket on MinIO.
df = spark.sql(
    """
    SELECT id, ST_GeomFromWKT(wkt) AS geometry FROM VALUES
      (1, 'POINT (28.0473 -26.2041)'),
      (2, 'POINT (28.0573 -26.1941)'),
      (3, 'POINT (18.4241 -33.9249)')
    AS t(id, wkt)
    """
)
df.write.format("geoparquet").mode("overwrite").save(OUT_PATH)
back = spark.read.format("geoparquet").load(OUT_PATH)
count = back.count()
assert count == 3, f"expected 3 rows back from {OUT_PATH}, got {count}"
print(f"[smoke] GeoParquet round-trip to {OUT_PATH}: {count} rows")

spark.stop()
print("SEDONA_SMOKE_OK")
sys.exit(0)
