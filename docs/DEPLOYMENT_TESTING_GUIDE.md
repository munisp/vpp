# Deployment Testing Guide

## Overview

This guide provides comprehensive testing procedures for all middleware integrations in the VPP Consumer Platform.

## Prerequisites

- All middleware services running (Kafka, Temporal, Redis, Keycloak)
- VPP Consumer Platform deployed
- Test user accounts created
- Access to monitoring tools

## Test Suite Overview

1. **Temporal Worker Tests** - Verify workflow execution
2. **Keycloak Authentication Tests** - Verify SSO integration
3. **Lakehouse ETL Tests** - Verify data pipeline
4. **Integration Tests** - Verify end-to-end flows
5. **Performance Tests** - Verify system performance
6. **Monitoring Tests** - Verify observability

## 1. Temporal Worker Tests

### Test 1.1: Worker Health Check

```bash
# Check worker process
pm2 status vpp-temporal-worker

# Expected output:
# │ name                  │ status │
# │ vpp-temporal-worker   │ online │
```

### Test 1.2: Worker Logs

```bash
# View worker logs
pm2 logs vpp-temporal-worker --lines 50

# Expected output should include:
# [Temporal Worker] Connected to Temporal server
# [Temporal Worker] Worker created for task queue: payment-processing
```

### Test 1.3: Temporal UI

1. Open http://localhost:8233
2. Navigate to **Workflows**
3. Verify task queue `payment-processing` exists
4. Check worker status shows active workers

### Test 1.4: Payment Workflow Execution

**Create test payment:**

```bash
curl -X POST http://localhost:3000/api/trpc/paymentProcessing.initiatePayment \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{
    "invoiceId": 1,
    "gateway": "mpesa",
    "phoneNumber": "255712345678"
  }'
```

**Verify in Temporal UI:**

1. Navigate to **Workflows**
2. Find workflow with ID starting with `payment-`
3. Verify workflow status is `Running` or `Completed`
4. Click workflow to view execution history
5. Verify all activities completed successfully

**Expected activities:**
- `initiatePaymentActivity`
- `verifyPaymentActivity`
- `updatePaymentStatusActivity`
- `updateBillingStatusActivity`
- `sendPaymentNotificationActivity`

### Test 1.5: Workflow Retry Logic

**Simulate payment gateway failure:**

1. Stop payment gateway service temporarily
2. Initiate payment (will fail)
3. Verify workflow retries automatically
4. Restart payment gateway
5. Verify workflow completes successfully

**Check in Temporal UI:**
- Activity should show retry attempts
- Backoff intervals should increase exponentially
- Final status should be `Completed` after gateway recovers

### Test 1.6: Workflow Compensation

**Simulate database failure:**

1. Initiate payment
2. Simulate database error during `updatePaymentStatusActivity`
3. Verify compensation workflow runs
4. Verify payment is reversed in gateway
5. Verify user is notified of failure

## 2. Keycloak Authentication Tests

### Test 2.1: Keycloak Health Check

```bash
# Test Keycloak server
curl http://localhost:8080/realms/vpp-platform

# Expected: JSON response with realm configuration
```

### Test 2.2: Client Health Check

```typescript
// Run in Node.js console
const { keycloakClient } = require('./server/integration/keycloak-client');

const health = await keycloakClient.healthCheck();
console.log(health);

// Expected: { connected: true, realm: 'vpp-platform' }
```

### Test 2.3: User Authentication

```bash
# Authenticate user
curl -X POST http://localhost:8080/realms/vpp-platform/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=vpp-consumer-platform" \
  -d "client_secret=<your-client-secret>" \
  -d "username=testuser" \
  -d "password=password"

# Expected: JSON with access_token, refresh_token, expires_in
```

### Test 2.4: Token Validation

```bash
# Validate token
curl -X POST http://localhost:8080/realms/vpp-platform/protocol/openid-connect/token/introspect \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=vpp-consumer-platform" \
  -d "client_secret=<your-client-secret>" \
  -d "token=<access-token>"

# Expected: { "active": true, "username": "testuser", ... }
```

### Test 2.5: User Info Retrieval

```bash
# Get user info
curl http://localhost:8080/realms/vpp-platform/protocol/openid-connect/userinfo \
  -H "Authorization: Bearer <access-token>"

# Expected: { "sub": "...", "email": "test@example.com", ... }
```

### Test 2.6: Role Assignment

```typescript
// Create user and assign role
const userId = await keycloakClient.createUser({
  username: 'newuser',
  email: 'new@example.com',
  firstName: 'New',
  lastName: 'User',
});

await keycloakClient.assignRole(userId, 'user');

const roles = await keycloakClient.getUserRoles(userId);
console.log(roles);

// Expected: [{ name: 'user', ... }]
```

### Test 2.7: Token Refresh

```bash
# Refresh token
curl -X POST http://localhost:8080/realms/vpp-platform/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "client_id=vpp-consumer-platform" \
  -d "client_secret=<your-client-secret>" \
  -d "refresh_token=<refresh-token>"

# Expected: New access_token and refresh_token
```

### Test 2.8: User Logout

```bash
# Logout user
curl -X POST http://localhost:8080/realms/vpp-platform/protocol/openid-connect/logout \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=vpp-consumer-platform" \
  -d "client_secret=<your-client-secret>" \
  -d "refresh_token=<refresh-token>"

# Expected: 204 No Content
```

## 3. Lakehouse Ingestion Tests

These replace the previous Kafka/Iceberg tests. The deployed job
(`services/lakehouse`) extracts from PostgreSQL to Parquet in an object store; it
does not consume Kafka, and there is no Iceberg catalog to inspect. Kafka reaches
the lake through the `event_inbox` table, which the platform's own consumer writes
transactionally and this job ingests like any other table.

### Test 3.1: The job runs and reports its own outcome

```bash
cd services/lakehouse
python -m lakehouse --datasets telemetry --max-batches 1
echo "exit status: $?"

# Expected: exit status 0. A dataset with nothing new logs `empty`, which is not a
# load. Any dataset failure makes the exit status non-zero.
```

### Test 3.2: Runs are recorded, with the error behind a failure

```bash
psql "$DATABASE_URL" -c "SELECT dataset, state, rows_written, bytes_written,
                                object_key, error
                           FROM lakehouse_runs ORDER BY id DESC LIMIT 10;"
```

Expected: one row per dataset attempted. A `succeeded` row **must** carry an
`object_key` and an `object_digest` — the job records success only after reading the
object back out of the store and comparing its SHA-256. A `failed` row carries the
exact database or object-store error, and its dataset's watermark is unchanged.

### Test 3.3: Ingestion is incremental and resumable

```bash
psql "$DATABASE_URL" -c "SELECT dataset, watermark_at, watermark_id, rows_ingested
                           FROM lakehouse_watermarks ORDER BY dataset;"

# Run again with no new source rows
python -m lakehouse --datasets telemetry --max-batches 1
```

Expected: the second run records `state='empty'` with no object, and the watermark
is unchanged. Killing a run mid-flight leaves a `running` row and an unmoved
watermark, so the next run re-reads the same rows rather than skipping them.

### Test 3.4: The object exists where the run says it does

```bash
# S3 / MinIO
aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://$LAKEHOUSE_BUCKET/$LAKEHOUSE_PREFIX/telemetry/" --recursive

# Local store
find "$LAKEHOUSE_LOCAL_PATH" -name '*.parquet' | head
```

Expected: an object at exactly the `object_key` from `lakehouse_runs`. Read it back
and check the digest matches `object_digest`:

```bash
sha256sum <downloaded-file>
```

### Test 3.5: The Parquet is readable and carries no subscriber contact details

```python
import pyarrow.parquet as pq

table = pq.read_table('<downloaded-file>')
print(table.num_rows, table.schema.names)

# Expected for the payments dataset: no `phoneNumber` and no `accountNumber`.
# Those columns are excluded by the dataset projection, so they never leave
# PostgreSQL.
```

### Test 3.6: Concurrent runners do not double-extract

```bash
python -m lakehouse --datasets telemetry & python -m lakehouse --datasets telemetry &
wait
```

Expected: one runner ingests, the other skips the dataset — each dataset is claimed
with a PostgreSQL advisory lock. Neither produces a duplicate object for the same
watermark range.

### Test 3.7: The console reports the real state, not the configuration

Open `/admin/lakehouse` (admin only), or call `trpc lakehouse.status`.

Expected: per-dataset `ingesting` / `stale` / `failing` / `never ingested`, the
backlog counted against each source table (`unknown` when it cannot be counted, not
zero), and the object key behind the newest successful run. A deployment where the
CronJob was never applied reads `never ingested` — it does not read healthy.

### Test 3.8: The test suite

```bash
./scripts/test-lakehouse-etl.sh

# With a database, which adds the pipeline tests:
LAKEHOUSE_TEST_DSN=postgres://vpp:vpp@127.0.0.1:5432/vpp_lake ./scripts/test-lakehouse-etl.sh
```

Without `LAKEHOUSE_TEST_DSN` the PostgreSQL pipeline tests are skipped and the run
says so; they are not reported as passed.

## 4. Integration Tests

### Test 4.1: End-to-End Payment Flow

**Complete payment flow with all integrations:**

1. **User authenticates** (Keycloak)
2. **Initiates payment** (VPP Platform)
3. **Workflow executes** (Temporal)
4. **Event published** (Kafka)
5. **Data stored** (Lakehouse)
6. **Cache updated** (Redis)

**Test script:**

```bash
#!/bin/bash

echo "1. Authenticate user..."
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:8080/realms/vpp-platform/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=vpp-consumer-platform" \
  -d "client_secret=<client-secret>" \
  -d "username=testuser" \
  -d "password=password")

ACCESS_TOKEN=$(echo $TOKEN_RESPONSE | jq -r '.access_token')
echo "Access token: ${ACCESS_TOKEN:0:20}..."

echo "2. Initiate payment..."
PAYMENT_RESPONSE=$(curl -s -X POST http://localhost:3000/api/trpc/paymentProcessing.initiatePayment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{"invoiceId": 1, "gateway": "mpesa", "phoneNumber": "255712345678"}')

echo "Payment response: $PAYMENT_RESPONSE"

echo "3. Wait for workflow execution..."
sleep 10

echo "4. Check Temporal workflow..."
# Open http://localhost:8233 and verify workflow

echo "5. Wait for ETL batch..."
sleep 60

echo "6. Verify data in lakehouse..."
python3 << EOF
from pyiceberg.catalog import load_catalog
catalog = load_catalog('vpp_lakehouse', warehouse='/tmp/iceberg-warehouse')
table = catalog.load_table('vpp.payments_initiated')
df = table.scan().to_arrow().to_pandas()
print(f"Total payments: {len(df)}")
EOF

echo "7. Check Redis cache..."
redis-cli -h localhost -p 6379 keys 'payment:*'

echo "Integration test complete!"
```

### Test 4.2: DR Event Flow

**Complete DR event flow:**

1. Create DR event
2. Users respond to event
3. Event starts
4. Telemetry monitored
5. Event completes
6. All events published to Kafka
7. All data stored in lakehouse

### Test 4.3: Trading Flow

**Complete trading flow:**

1. User places trade
2. Trade matched
3. Trade settled
4. Payment processed (Temporal)
5. Events published (Kafka)
6. Data stored (Lakehouse)

## 5. Performance Tests

### Test 5.1: Temporal Workflow Throughput

**Load test:**

```bash
# Generate 100 concurrent payments
for i in {1..100}; do
  curl -X POST http://localhost:3000/api/trpc/paymentProcessing.initiatePayment \
    -H "Content-Type: application/json" \
    -H "Cookie: session=<session>" \
    -d '{"invoiceId": '$i', "gateway": "mpesa", "phoneNumber": "255712345678"}' &
done

wait

# Monitor in Temporal UI
# Check task queue backlog
# Verify all workflows complete within 5 minutes
```

**Metrics to check:**
- Workflow execution time: <30 seconds per workflow
- Task queue backlog: <100 workflows
- Worker CPU usage: <80%
- Worker memory usage: <512MB per instance

### Test 5.2: Keycloak Authentication Throughput

**Load test:**

```bash
# Generate 100 concurrent authentications
for i in {1..100}; do
  curl -X POST http://localhost:8080/realms/vpp-platform/protocol/openid-connect/token \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=password" \
    -d "client_id=vpp-consumer-platform" \
    -d "client_secret=<secret>" \
    -d "username=testuser" \
    -d "password=password" &
done

wait

# Check Keycloak logs for errors
# Verify all authentications succeed
```

**Metrics to check:**
- Authentication time: <500ms per request
- Token generation time: <100ms
- Keycloak CPU usage: <70%
- Keycloak memory usage: <1GB

### Test 5.3: Lakehouse ETL Throughput

**Load test:**

```bash
# Generate 10000 events
for i in {1..10000}; do
  # Trigger various events
  curl -X POST http://localhost:3000/api/trpc/... &
  
  # Throttle to avoid overwhelming system
  if [ $((i % 100)) -eq 0 ]; then
    wait
    sleep 1
  fi
done

# Monitor ETL consumer lag
docker exec -it nextgen_kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group lakehouse-etl

# Verify lag decreases over time
```

**Metrics to check:**
- ETL processing rate: >1000 events/minute
- Consumer lag: <1000 messages
- ETL CPU usage: <80%
- ETL memory usage: <512MB

## 6. Monitoring Tests

### Test 6.1: Prometheus Metrics

**Check metrics endpoint:**

```bash
curl http://localhost:3000/metrics

# Expected metrics:
# kafka_messages_published_total{topic="vpp.payments.initiated",status="success"} 123
# kafka_publish_duration_seconds{topic="vpp.payments.initiated",quantile="0.95"} 0.05
```

### Test 6.2: Cache Monitoring Dashboard

1. Open http://localhost:3000/admin/cache-monitoring
2. Verify real-time statistics display
3. Check cache hit rate: >80%
4. Check response time: <10ms
5. Verify cache breakdown by type

### Test 6.3: Temporal UI Monitoring

1. Open http://localhost:8233
2. Navigate to **Workflows**
3. Check workflow success rate: >99%
4. Navigate to **Task Queues**
5. Check `payment-processing` queue
6. Verify worker count: 2 workers
7. Check backlog: <10 workflows

### Test 6.4: Kafka Monitoring

```bash
# Check broker status
docker exec -it nextgen_kafka kafka-broker-api-versions \
  --bootstrap-server localhost:9092

# Check topic lag
for topic in vpp.telemetry.raw vpp.trades.created vpp.payments.initiated; do
  echo "Topic: $topic"
  docker exec -it nextgen_kafka kafka-consumer-groups \
    --bootstrap-server localhost:9092 \
    --describe \
    --group lakehouse-etl \
    | grep $topic
done
```

## 7. Failure Tests

### Test 7.1: Temporal Worker Failure

```bash
# Stop worker
pm2 stop vpp-temporal-worker

# Initiate payment (should fail gracefully)
curl -X POST http://localhost:3000/api/trpc/paymentProcessing.initiatePayment \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<session>" \
  -d '{"invoiceId": 1, "gateway": "mpesa", "phoneNumber": "255712345678"}'

# Expected: Graceful degradation, payment still processed (without workflow)

# Restart worker
pm2 start vpp-temporal-worker

# Verify worker reconnects
pm2 logs vpp-temporal-worker
```

### Test 7.2: Keycloak Failure

```bash
# Stop Keycloak
docker stop nextgen_keycloak

# Test authentication (should fail gracefully)
curl http://localhost:8080/realms/vpp-platform

# Expected: Connection refused

# Verify VPP platform authenticates through Keycloak OpenID Connect
# Users can authenticate through the configured Keycloak realm

# Restart Keycloak
docker start nextgen_keycloak

# Verify Keycloak recovers
curl http://localhost:8080/realms/vpp-platform
```

### Test 7.3: Kafka Failure

```bash
# Stop Kafka
docker stop nextgen_kafka

# Trigger events (should fail gracefully)
# Expected: Events not published, but operations continue

# Check logs for graceful degradation
pm2 logs vpp-web | grep Kafka

# Restart Kafka
docker start nextgen_kafka

# Verify reconnection
pm2 logs vpp-web | grep "Kafka.*Connected"
```

### Test 7.4: ETL Failure

```bash
# Stop ETL
sudo systemctl stop vpp-lakehouse-etl

# Trigger events (should queue in Kafka)
# Expected: Events accumulate in Kafka topics

# Check consumer lag
docker exec -it nextgen_kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group lakehouse-etl

# Expected: Lag increases

# Restart ETL
sudo systemctl start vpp-lakehouse-etl

# Verify ETL catches up
# Expected: Lag decreases to 0
```

## Test Results Template

```markdown
# Deployment Test Results

**Date:** 2024-01-15
**Tester:** John Doe
**Environment:** Production

## 1. Temporal Worker Tests
- [ ] Worker health check: PASS/FAIL
- [ ] Worker logs: PASS/FAIL
- [ ] Temporal UI: PASS/FAIL
- [ ] Payment workflow execution: PASS/FAIL
- [ ] Workflow retry logic: PASS/FAIL
- [ ] Workflow compensation: PASS/FAIL

## 2. Keycloak Authentication Tests
- [ ] Keycloak health check: PASS/FAIL
- [ ] Client health check: PASS/FAIL
- [ ] User authentication: PASS/FAIL
- [ ] Token validation: PASS/FAIL
- [ ] User info retrieval: PASS/FAIL
- [ ] Role assignment: PASS/FAIL
- [ ] Token refresh: PASS/FAIL
- [ ] User logout: PASS/FAIL

## 3. Lakehouse ETL Tests
- [ ] ETL service status: PASS/FAIL
- [ ] ETL logs: PASS/FAIL
- [ ] Kafka consumer group: PASS/FAIL
- [ ] Iceberg tables creation: PASS/FAIL
- [ ] Data ingestion: PASS/FAIL
- [ ] Schema validation: PASS/FAIL
- [ ] Time travel query: PASS/FAIL

## 4. Integration Tests
- [ ] End-to-end payment flow: PASS/FAIL
- [ ] DR event flow: PASS/FAIL
- [ ] Trading flow: PASS/FAIL

## 5. Performance Tests
- [ ] Temporal workflow throughput: PASS/FAIL
- [ ] Keycloak authentication throughput: PASS/FAIL
- [ ] Lakehouse ETL throughput: PASS/FAIL

## 6. Monitoring Tests
- [ ] Prometheus metrics: PASS/FAIL
- [ ] Cache monitoring dashboard: PASS/FAIL
- [ ] Temporal UI monitoring: PASS/FAIL
- [ ] Kafka monitoring: PASS/FAIL

## 7. Failure Tests
- [ ] Temporal worker failure: PASS/FAIL
- [ ] Keycloak failure: PASS/FAIL
- [ ] Kafka failure: PASS/FAIL
- [ ] ETL failure: PASS/FAIL

## Summary
- Total tests: 34
- Passed: X
- Failed: Y
- Success rate: Z%

## Issues Found
1. Issue description
2. Issue description

## Recommendations
1. Recommendation
2. Recommendation
```

## Support

For issues or questions:
- **Temporal**: http://localhost:8233
- **Keycloak**: http://localhost:8080
- **Cache Dashboard**: http://localhost:3000/admin/cache-monitoring
- **Documentation**: `docs/MIDDLEWARE_DEPLOYMENT_GUIDE.md`
