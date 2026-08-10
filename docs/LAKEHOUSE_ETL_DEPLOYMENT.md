# Lakehouse ETL Pipeline Deployment Guide

## Overview

This guide provides instructions for deploying the Lakehouse ETL pipeline that consumes Kafka events and writes to Apache Iceberg tables for long-term analytics.

## Prerequisites

- Python 3.11 or higher
- Kafka server running (NextGen VPP Platform)
- Apache Iceberg-compatible storage (local filesystem, S3, HDFS)
- VPP Consumer Platform with Kafka integration

## Step 1: Install Python Dependencies

### Create Virtual Environment

```bash
cd /home/ubuntu/vpp_consumer_platform/server/integration
python3 -m venv venv
source venv/bin/activate
```

### Install Dependencies

```bash
pip install -r requirements.txt
```

**Dependencies installed:**
- `confluent-kafka==2.3.0` - Kafka consumer
- `pandas==2.2.0` - Data processing
- `pyiceberg==0.6.1` - Iceberg table management
- `pyarrow==15.0.0` - Columnar data format
- `python-dotenv==1.0.1` - Environment variable management

### Verify Installation

```bash
python -c "import confluent_kafka; print('Kafka OK')"
python -c "import pandas; print('Pandas OK')"
python -c "import pyiceberg; print('Iceberg OK')"
python -c "import pyarrow; print('PyArrow OK')"
```

## Step 2: Configure Environment

### Create .env File

Create `/home/ubuntu/vpp_consumer_platform/server/integration/.env`:

```bash
# Kafka Configuration
KAFKA_BOOTSTRAP_SERVERS=localhost:9092
KAFKA_GROUP_ID=lakehouse-etl
KAFKA_AUTO_OFFSET_RESET=earliest

# Iceberg Configuration
ICEBERG_CATALOG_NAME=vpp_lakehouse
ICEBERG_WAREHOUSE_PATH=/tmp/iceberg-warehouse
ICEBERG_NAMESPACE=vpp
```

### Production Configuration

For production, use S3 or HDFS for Iceberg warehouse:

**S3 Configuration:**

```bash
# Kafka Configuration
KAFKA_BOOTSTRAP_SERVERS=kafka1:9092,kafka2:9092,kafka3:9092
KAFKA_GROUP_ID=lakehouse-etl
KAFKA_AUTO_OFFSET_RESET=earliest
KAFKA_SASL_MECHANISM=SCRAM-SHA-512
KAFKA_SASL_USERNAME=vpp-etl
KAFKA_SASL_PASSWORD=<secure-password>
KAFKA_SSL_ENABLED=true

# Iceberg Configuration (S3)
ICEBERG_CATALOG_NAME=vpp_lakehouse
ICEBERG_CATALOG_TYPE=glue
ICEBERG_WAREHOUSE_PATH=s3://vpp-lakehouse/warehouse
ICEBERG_NAMESPACE=vpp
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>
```

**HDFS Configuration:**

```bash
# Iceberg Configuration (HDFS)
ICEBERG_CATALOG_NAME=vpp_lakehouse
ICEBERG_CATALOG_TYPE=hadoop
ICEBERG_WAREHOUSE_PATH=hdfs://namenode:8020/vpp-lakehouse
ICEBERG_NAMESPACE=vpp
```

## Step 3: Create Storage Directory

### Local Filesystem

```bash
mkdir -p /tmp/iceberg-warehouse
chmod 755 /tmp/iceberg-warehouse
```

### S3 Bucket

```bash
# Create S3 bucket
aws s3 mb s3://vpp-lakehouse

# Set bucket policy
aws s3api put-bucket-versioning \
  --bucket vpp-lakehouse \
  --versioning-configuration Status=Enabled
```

### HDFS Directory

```bash
# Create HDFS directory
hdfs dfs -mkdir -p /vpp-lakehouse
hdfs dfs -chmod 755 /vpp-lakehouse
```

## Step 4: Test ETL Pipeline

### Run in Development Mode

```bash
cd /home/ubuntu/vpp_consumer_platform/server/integration
source venv/bin/activate
python lakehouse-etl.py
```

**Expected output:**

```
2024-01-15 10:00:00 - __main__ - INFO - Starting Lakehouse ETL pipeline...
2024-01-15 10:00:01 - __main__ - INFO - Kafka consumer created, subscribed to 10 topics
2024-01-15 10:00:02 - __main__ - INFO - Iceberg catalog loaded: vpp_lakehouse
2024-01-15 10:00:03 - __main__ - INFO - Waiting for messages...
```

### Test with Sample Events

In another terminal, publish test events:

```bash
# Navigate to VPP platform
cd /home/ubuntu/vpp_consumer_platform

# Trigger some events (e.g., create a payment)
curl -X POST http://localhost:3000/api/trpc/paymentProcessing.initiatePayment \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"invoiceId": 1, "gateway": "mpesa", "phoneNumber": "255712345678"}'
```

**ETL logs should show:**

```
2024-01-15 10:01:00 - __main__ - INFO - Created table: vpp.payments_initiated
2024-01-15 10:01:01 - __main__ - INFO - Flushed 1 records to vpp.payments_initiated
```

### Verify Data in Iceberg

```python
from pyiceberg.catalog import load_catalog

# Load catalog
catalog = load_catalog(
    'vpp_lakehouse',
    **{
        "type": "hadoop",
        "warehouse": "/tmp/iceberg-warehouse",
    }
)

# Load table
table = catalog.load_table('vpp.payments_initiated')

# Query data
df = table.scan().to_arrow().to_pandas()
print(df.head())
```

## Step 5: Deploy as Service

### Option 1: Systemd Service

Create `/etc/systemd/system/vpp-lakehouse-etl.service`:

```ini
[Unit]
Description=VPP Lakehouse ETL Pipeline
After=network.target kafka.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/vpp_consumer_platform/server/integration
Environment="PATH=/home/ubuntu/vpp_consumer_platform/server/integration/venv/bin"
EnvironmentFile=/home/ubuntu/vpp_consumer_platform/server/integration/.env
ExecStart=/home/ubuntu/vpp_consumer_platform/server/integration/venv/bin/python lakehouse-etl.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vpp-lakehouse-etl

[Install]
WantedBy=multi-user.target
```

**Enable and start:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable vpp-lakehouse-etl
sudo systemctl start vpp-lakehouse-etl
sudo systemctl status vpp-lakehouse-etl
```

**View logs:**

```bash
sudo journalctl -u vpp-lakehouse-etl -f
```

### Option 2: Docker Container

Create `Dockerfile.etl`:

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY server/integration/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy ETL script
COPY server/integration/lakehouse-etl.py .

# Run ETL
CMD ["python", "lakehouse-etl.py"]
```

**Build and run:**

```bash
docker build -f Dockerfile.etl -t vpp-lakehouse-etl .

docker run -d \
  --name vpp-etl \
  --restart unless-stopped \
  -e KAFKA_BOOTSTRAP_SERVERS=kafka:9092 \
  -e ICEBERG_WAREHOUSE_PATH=/data/iceberg \
  -v /data/iceberg:/data/iceberg \
  vpp-lakehouse-etl
```

### Option 3: Docker Compose

Add to `docker-compose.yml`:

```yaml
services:
  vpp-etl:
    build:
      context: .
      dockerfile: Dockerfile.etl
    container_name: vpp-lakehouse-etl
    restart: unless-stopped
    environment:
      - KAFKA_BOOTSTRAP_SERVERS=kafka:9092
      - KAFKA_GROUP_ID=lakehouse-etl
      - ICEBERG_WAREHOUSE_PATH=/data/iceberg
      - ICEBERG_NAMESPACE=vpp
    volumes:
      - ./data/iceberg:/data/iceberg
    depends_on:
      - kafka
    networks:
      - vpp-network
```

**Start:**

```bash
docker-compose up -d vpp-etl
docker-compose logs -f vpp-etl
```

### Option 4: Kubernetes Deployment

Create `k8s/lakehouse-etl-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpp-lakehouse-etl
  namespace: vpp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vpp-lakehouse-etl
  template:
    metadata:
      labels:
        app: vpp-lakehouse-etl
    spec:
      containers:
      - name: etl
        image: vpp-lakehouse-etl:latest
        env:
        - name: KAFKA_BOOTSTRAP_SERVERS
          value: "kafka:9092"
        - name: KAFKA_GROUP_ID
          value: "lakehouse-etl"
        - name: ICEBERG_WAREHOUSE_PATH
          value: "s3://vpp-lakehouse/warehouse"
        - name: AWS_REGION
          value: "us-east-1"
        - name: AWS_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: aws-credentials
              key: access-key-id
        - name: AWS_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: aws-credentials
              key: secret-access-key
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: vpp-etl-data
      restartPolicy: Always
```

**Deploy:**

```bash
kubectl apply -f k8s/lakehouse-etl-deployment.yaml
kubectl logs -f deployment/vpp-lakehouse-etl -n vpp
```

## Step 6: Configure Batch Processing

### Adjust Batch Size

Edit `lakehouse-etl.py`:

```python
# For high-volume workloads
BATCH_SIZE = 5000
BATCH_TIMEOUT_SECONDS = 30

# For low-volume workloads
BATCH_SIZE = 100
BATCH_TIMEOUT_SECONDS = 120
```

### Tune Kafka Consumer

```python
config = {
    'bootstrap.servers': KAFKA_BOOTSTRAP_SERVERS,
    'group.id': KAFKA_GROUP_ID,
    'auto.offset.reset': KAFKA_AUTO_OFFSET_RESET,
    'enable.auto.commit': False,
    'max.poll.interval.ms': 300000,  # 5 minutes
    'fetch.min.bytes': 1024,         # 1 KB
    'fetch.max.wait.ms': 500,        # 500 ms
}
```

## Step 7: Query Iceberg Tables

### Using Python

```python
from pyiceberg.catalog import load_catalog
import pandas as pd

# Load catalog
catalog = load_catalog('vpp_lakehouse', warehouse='/tmp/iceberg-warehouse')

# List tables
tables = catalog.list_tables('vpp')
print("Available tables:", tables)

# Query payments
payments_table = catalog.load_table('vpp.payments_initiated')
payments_df = payments_table.scan().to_arrow().to_pandas()

# Filter by date
from datetime import datetime, timedelta
yesterday = datetime.now() - timedelta(days=1)
recent_payments = payments_df[payments_df['timestamp'] > yesterday]

print(f"Payments in last 24h: {len(recent_payments)}")
print(recent_payments.head())

# Aggregate statistics
total_amount = recent_payments['amount'].sum()
avg_amount = recent_payments['amount'].mean()
print(f"Total: {total_amount}, Average: {avg_amount}")
```

### Using Spark

```python
from pyspark.sql import SparkSession

# Create Spark session with Iceberg
spark = SparkSession.builder \
    .appName("VPP Analytics") \
    .config("spark.sql.catalog.vpp_lakehouse", "org.apache.iceberg.spark.SparkCatalog") \
    .config("spark.sql.catalog.vpp_lakehouse.type", "hadoop") \
    .config("spark.sql.catalog.vpp_lakehouse.warehouse", "/tmp/iceberg-warehouse") \
    .getOrCreate()

# Query payments
payments_df = spark.sql("""
    SELECT 
        DATE(timestamp) as date,
        gateway,
        COUNT(*) as payment_count,
        SUM(amount) as total_amount,
        AVG(amount) as avg_amount
    FROM vpp_lakehouse.vpp.payments_initiated
    WHERE timestamp >= CURRENT_DATE - INTERVAL 7 DAYS
    GROUP BY DATE(timestamp), gateway
    ORDER BY date DESC, gateway
""")

payments_df.show()
```

### Using Trino/Presto

```sql
-- Connect to Trino with Iceberg catalog
-- Query payments by gateway
SELECT 
    gateway,
    COUNT(*) as payment_count,
    SUM(amount) as total_amount,
    AVG(amount) as avg_amount
FROM vpp_lakehouse.vpp.payments_initiated
WHERE date(timestamp) = CURRENT_DATE
GROUP BY gateway;

-- Query DR event participation
SELECT 
    event_id,
    COUNT(*) as participant_count,
    SUM(CASE WHEN participated THEN 1 ELSE 0 END) as participated_count,
    AVG(actual_reduction) as avg_reduction
FROM vpp_lakehouse.vpp.dr_responses
GROUP BY event_id;
```

## Step 8: Monitoring

### Check ETL Status

**Systemd:**

```bash
sudo systemctl status vpp-lakehouse-etl
sudo journalctl -u vpp-lakehouse-etl -n 100 -f
```

**Docker:**

```bash
docker ps | grep vpp-etl
docker logs -f vpp-etl
```

**Kubernetes:**

```bash
kubectl get pods -n vpp | grep etl
kubectl logs -f deployment/vpp-lakehouse-etl -n vpp
```

### Monitor Kafka Consumer Lag

```bash
# Check consumer group
docker exec -it nextgen_kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group lakehouse-etl

# Expected output:
# GROUP           TOPIC                    PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# lakehouse-etl   vpp.payments.initiated   0          1234            1234            0
```

### Monitor Iceberg Tables

```python
from pyiceberg.catalog import load_catalog

catalog = load_catalog('vpp_lakehouse', warehouse='/tmp/iceberg-warehouse')

# Get table metadata
table = catalog.load_table('vpp.payments_initiated')
print(f"Table location: {table.location()}")
print(f"Current snapshot: {table.current_snapshot()}")
print(f"Schema: {table.schema()}")

# Get table statistics
stats = table.scan().to_arrow()
print(f"Total rows: {len(stats)}")
print(f"Table size: {stats.nbytes / 1024 / 1024:.2f} MB")
```

## Step 9: Maintenance

### Compact Iceberg Tables

```python
from pyiceberg.catalog import load_catalog

catalog = load_catalog('vpp_lakehouse', warehouse='/tmp/iceberg-warehouse')
table = catalog.load_table('vpp.payments_initiated')

# Compact small files
table.rewrite_data_files()
```

### Expire Old Snapshots

```python
from datetime import datetime, timedelta

# Expire snapshots older than 7 days
expire_timestamp = datetime.now() - timedelta(days=7)
table.expire_snapshots(older_than=expire_timestamp)
```

### Vacuum Deleted Files

```python
# Remove orphan files
table.remove_orphan_files()
```

## Troubleshooting

### ETL Not Consuming Messages

**Check Kafka connection:**

```bash
# Test Kafka broker
docker exec -it nextgen_kafka kafka-broker-api-versions \
  --bootstrap-server localhost:9092
```

**Check consumer group:**

```bash
docker exec -it nextgen_kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --list | grep lakehouse
```

**Check ETL logs:**

```bash
sudo journalctl -u vpp-lakehouse-etl -n 100
```

### Iceberg Tables Not Created

**Check warehouse directory:**

```bash
ls -la /tmp/iceberg-warehouse
```

**Check permissions:**

```bash
chmod 755 /tmp/iceberg-warehouse
chown ubuntu:ubuntu /tmp/iceberg-warehouse
```

**Check catalog configuration:**

```python
# Test catalog connection
from pyiceberg.catalog import load_catalog

try:
    catalog = load_catalog('vpp_lakehouse', warehouse='/tmp/iceberg-warehouse')
    print("Catalog loaded successfully")
except Exception as e:
    print(f"Error: {e}")
```

### High Memory Usage

**Reduce batch size:**

```python
BATCH_SIZE = 500  # Reduce from 1000
```

**Enable memory limits (Docker):**

```bash
docker run -d \
  --name vpp-etl \
  --memory="512m" \
  --memory-swap="512m" \
  vpp-lakehouse-etl
```

**Enable memory limits (Kubernetes):**

```yaml
resources:
  limits:
    memory: "512Mi"
```

### Consumer Lag Increasing

**Scale horizontally:**

Run multiple ETL instances with same `KAFKA_GROUP_ID`:

```bash
# Start 3 instances
docker run -d --name vpp-etl-1 vpp-lakehouse-etl
docker run -d --name vpp-etl-2 vpp-lakehouse-etl
docker run -d --name vpp-etl-3 vpp-lakehouse-etl
```

**Increase batch size:**

```python
BATCH_SIZE = 5000  # Increase from 1000
BATCH_TIMEOUT_SECONDS = 30  # Reduce from 60
```

## Performance Tuning

### Optimal Configuration

**Low volume (<1000 events/min):**

```python
BATCH_SIZE = 100
BATCH_TIMEOUT_SECONDS = 120
```

**Medium volume (1000-10000 events/min):**

```python
BATCH_SIZE = 1000
BATCH_TIMEOUT_SECONDS = 60
```

**High volume (>10000 events/min):**

```python
BATCH_SIZE = 5000
BATCH_TIMEOUT_SECONDS = 30
```

### Kafka Consumer Tuning

```python
config = {
    'fetch.min.bytes': 10240,      # 10 KB
    'fetch.max.wait.ms': 100,      # 100 ms
    'max.partition.fetch.bytes': 1048576,  # 1 MB
}
```

## Support

For issues or questions:
- **ETL Logs**: `sudo journalctl -u vpp-lakehouse-etl -f`
- **Kafka Monitoring**: NextGen VPP Platform logs
- **Iceberg Documentation**: https://iceberg.apache.org/docs/latest/
- **Deployment Guide**: `docs/MIDDLEWARE_DEPLOYMENT_GUIDE.md`
