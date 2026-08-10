# VPP Platform Middleware Deployment Guide

## Overview

This guide provides step-by-step instructions for deploying and configuring all middleware integrations for the VPP Consumer Platform.

## Prerequisites

### Software Requirements

- **Node.js**: 22.13.0 or higher
- **Python**: 3.11+ (for lakehouse ETL)
- **Docker**: 20.10+ (for middleware services)
- **pnpm**: 10.4.1 or higher

### Middleware Services

All middleware services are deployed via the NextGen VPP Platform:

```bash
cd /home/ubuntu/nextgen_vpp_platform
docker-compose up -d
```

This starts:
- **Kafka**: Port 9092 (event streaming)
- **Temporal**: Port 7233 (gRPC), 8233 (Web UI)
- **Redis**: Port 6379 (caching)
- **Keycloak**: Port 8080 (authentication) - *optional*
- **APISIX**: Port 9080 (API gateway) - *optional*

## 1. Temporal Workflow Integration

### Install Dependencies

```bash
cd /home/ubuntu/vpp_consumer_platform
pnpm add @temporalio/worker @temporalio/workflow @temporalio/activity @temporalio/client
```

### Environment Variables

Add to `.env` (or set in environment):

```bash
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
```

### Start Temporal Worker

The worker processes payment workflows from the Temporal server.

**Option 1: Run as separate process**

```bash
cd /home/ubuntu/vpp_consumer_platform
tsx server/workflows/worker.ts
```

**Option 2: Add to package.json scripts**

```json
{
  "scripts": {
    "worker": "tsx server/workflows/worker.ts",
    "worker:dev": "tsx watch server/workflows/worker.ts"
  }
}
```

Then run:

```bash
pnpm run worker:dev
```

**Option 3: Use process manager (production)**

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: 'vpp-web',
      script: 'server/_core/index.ts',
      interpreter: 'tsx',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'vpp-worker',
      script: 'server/workflows/worker.ts',
      interpreter: 'tsx',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

Start with PM2:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Verify Integration

1. **Check Temporal UI**: http://localhost:8233
2. **Initiate a payment** through the platform
3. **View workflow execution** in Temporal UI
4. **Check logs** for workflow activity

### Workflow Features

- **Payment Processing**:
  - Initiate payment with gateway
  - Verify payment status with retries
  - Update database records
  - Send notifications
  - Publish Kafka events
  - Automatic compensation on failure

- **Refund Processing**:
  - Process refund with gateway
  - Update payment status
  - Revert billing status
  - Notify user

### Configuration

Workflows are configured in `server/workflows/payment-workflow.ts`:

- **Workflow Timeout**: 10 minutes
- **Run Timeout**: 5 minutes
- **Task Timeout**: 30 seconds
- **Retry Policy**:
  - Initial interval: 1 second
  - Backoff coefficient: 2x
  - Maximum interval: 60 seconds
  - Maximum attempts: 5

## 2. Kafka Event Streaming

### Verify Connection

Kafka publisher auto-connects on first use. Check logs:

```bash
# Should see:
[Kafka] Connected to broker
```

### Monitor Events

**View published events:**

```bash
# In NextGen platform
docker exec -it nextgen_kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic vpp.payments.initiated \
  --from-beginning
```

**List all topics:**

```bash
docker exec -it nextgen_kafka kafka-topics \
  --bootstrap-server localhost:9092 \
  --list
```

### Event Topics

| Topic | Description | Producer |
|-------|-------------|----------|
| `vpp.telemetry.raw` | Device telemetry data | Telemetry router |
| `vpp.trades.created` | New trade events | Trading router |
| `vpp.trades.settled` | Completed trades | Trading router |
| `vpp.payments.initiated` | Payment initiation | Payment router |
| `vpp.payments.completed` | Payment success | Temporal workflow |
| `vpp.payments.failed` | Payment failure | Temporal workflow |
| `vpp.dr.events.created` | DR event creation | DR router |
| `vpp.dr.events.started` | DR event start | DR router |
| `vpp.dr.events.completed` | DR event completion | DR router |
| `vpp.dr.responses` | DR participant responses | DR router |

### Metrics

Prometheus metrics available at `/metrics`:

- `kafka_messages_published_total{topic, status}`
- `kafka_publish_duration_seconds{topic}`

## 3. Redis Caching

### Verify Connection

Redis auto-connects on first use. Check health:

```bash
redis-cli -h localhost -p 6379 ping
# Should return: PONG
```

### Cache Monitoring Dashboard

Access at: **http://localhost:3000/admin/cache-monitoring**

Features:
- Real-time cache statistics
- Performance metrics (response times, P95, P99)
- Cache breakdown by type
- Cache management (clear by pattern)
- Auto-refresh every 5 seconds

### Cache Patterns

| Pattern | TTL | Description |
|---------|-----|-------------|
| `user:{userId}` | 5 min | User profiles |
| `asset:{assetId}` | 10 min | Asset details |
| `price:market` | 1 min | Market prices |
| `dr:event:{eventId}` | 3 min | DR events |
| `telemetry:{userId}:{assetId}` | 2 min | Telemetry data |
| `payment:{paymentId}` | 5 min | Payment records |
| `trade:{tradeId}` | 5 min | Trade records |

### Manual Cache Operations

```bash
# View all keys
redis-cli -h localhost -p 6379 keys '*'

# Get cache stats
redis-cli -h localhost -p 6379 info stats

# Clear specific pattern
redis-cli -h localhost -p 6379 --scan --pattern 'user:*' | xargs redis-cli -h localhost -p 6379 del

# Clear all cache
redis-cli -h localhost -p 6379 flushdb
```

## 4. Keycloak Authentication (Optional)

### Deploy Keycloak

If not already running in NextGen platform:

```bash
cd /home/ubuntu/nextgen_vpp_platform
docker-compose up -d keycloak
```

### Environment Variables

```bash
KEYCLOAK_SERVER_URL=http://localhost:8080
KEYCLOAK_REALM=vpp-platform
KEYCLOAK_CLIENT_ID=vpp-consumer-platform
KEYCLOAK_CLIENT_SECRET=<your-client-secret>
```

### Initial Setup

1. **Access Keycloak Admin Console**: http://localhost:8080
2. **Login** with admin credentials
3. **Create Realm**: `vpp-platform`
4. **Create Client**:
   - Client ID: `vpp-consumer-platform`
   - Client Protocol: `openid-connect`
   - Access Type: `confidential`
   - Valid Redirect URIs: `http://localhost:3000/*`
5. **Get Client Secret** from Credentials tab
6. **Create Roles**: `admin`, `user`

### Integration

The Keycloak client is available at `server/integration/keycloak-client.ts`.

**Example usage:**

```typescript
import { keycloakClient } from './integration/keycloak-client';

// Authenticate user
const token = await keycloakClient.authenticateUser('username', 'password');

// Validate token
const isValid = await keycloakClient.validateToken(token.access_token);

// Get user info
const userInfo = await keycloakClient.getUserInfo(token.access_token);

// Create user
const userId = await keycloakClient.createUser({
  username: 'newuser',
  email: 'user@example.com',
  firstName: 'John',
  lastName: 'Doe',
});

// Assign role
await keycloakClient.assignRole(userId, 'user');
```

### Health Check

```typescript
const health = await keycloakClient.healthCheck();
console.log(health); // { connected: true, realm: 'vpp-platform' }
```

## 5. Lakehouse ETL Pipeline (Optional)

### Install Python Dependencies

```bash
cd /home/ubuntu/vpp_consumer_platform/server/integration
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Environment Variables

```bash
KAFKA_BOOTSTRAP_SERVERS=localhost:9092
KAFKA_GROUP_ID=lakehouse-etl
KAFKA_AUTO_OFFSET_RESET=earliest
ICEBERG_CATALOG_NAME=vpp_lakehouse
ICEBERG_WAREHOUSE_PATH=/tmp/iceberg-warehouse
ICEBERG_NAMESPACE=vpp
```

### Run ETL Pipeline

```bash
cd /home/ubuntu/vpp_consumer_platform/server/integration
source venv/bin/activate
python lakehouse-etl.py
```

### Run as Service (Production)

Create systemd service `/etc/systemd/system/vpp-etl.service`:

```ini
[Unit]
Description=VPP Lakehouse ETL Pipeline
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/vpp_consumer_platform/server/integration
Environment="PATH=/home/ubuntu/vpp_consumer_platform/server/integration/venv/bin"
ExecStart=/home/ubuntu/vpp_consumer_platform/server/integration/venv/bin/python lakehouse-etl.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable vpp-etl
sudo systemctl start vpp-etl
sudo systemctl status vpp-etl
```

### Verify ETL

```bash
# Check logs
sudo journalctl -u vpp-etl -f

# Should see:
# Starting Lakehouse ETL pipeline...
# Kafka consumer created, subscribed to 10 topics
# Iceberg catalog loaded: vpp_lakehouse
```

### Query Iceberg Tables

```python
from pyiceberg.catalog import load_catalog

catalog = load_catalog('vpp_lakehouse', warehouse='/tmp/iceberg-warehouse')
table = catalog.load_table('vpp.payments_initiated')

# Query with PyArrow
df = table.scan().to_arrow().to_pandas()
print(df.head())
```

## 6. Monitoring and Observability

### Prometheus Metrics

Metrics are exposed at `/metrics` endpoint.

**Key metrics:**

```promql
# Kafka
kafka_messages_published_total{topic="vpp.payments.initiated", status="success"}
kafka_publish_duration_seconds{topic="vpp.payments.initiated", quantile="0.95"}

# Redis (via monitoring dashboard)
# Access at /admin/cache-monitoring

# Temporal (via Temporal UI)
# Access at http://localhost:8233
```

### Grafana Dashboards

Import dashboards from `docs/grafana/`:

1. **Kafka Events Dashboard** - Message throughput and latency
2. **Redis Cache Dashboard** - Hit rates and response times
3. **Temporal Workflows Dashboard** - Workflow execution metrics

### Health Checks

All integrations include health check endpoints:

```typescript
// Kafka
await kafkaPublisher.connect(); // Throws if unavailable

// Redis
const redisHealth = await redisCache.healthCheck();
// { connected: true, latency: 2 }

// Temporal
const temporalHealth = await temporalClient.healthCheck();
// { connected: true }

// Keycloak
const keycloakHealth = await keycloakClient.healthCheck();
// { connected: true, realm: 'vpp-platform' }
```

## 7. Production Deployment

### Environment Variables

Create `.env.production`:

```bash
# Database
DATABASE_URL=mysql://user:password@prod-db:3306/vpp_platform

# Temporal
TEMPORAL_ADDRESS=temporal.prod.example.com:7233
TEMPORAL_NAMESPACE=production
TEMPORAL_TLS_ENABLED=true
TEMPORAL_TLS_CERT_PATH=/path/to/cert.pem
TEMPORAL_TLS_KEY_PATH=/path/to/key.pem

# Kafka
KAFKA_BOOTSTRAP_SERVERS=kafka1.prod:9092,kafka2.prod:9092,kafka3.prod:9092
KAFKA_SASL_MECHANISM=SCRAM-SHA-512
KAFKA_SASL_USERNAME=vpp-platform
KAFKA_SASL_PASSWORD=<secure-password>
KAFKA_SSL_ENABLED=true

# Redis
REDIS_HOST=redis.prod.example.com
REDIS_PORT=6379
REDIS_PASSWORD=<secure-password>
REDIS_TLS_ENABLED=true

# Keycloak
KEYCLOAK_SERVER_URL=https://auth.example.com
KEYCLOAK_REALM=vpp-platform
KEYCLOAK_CLIENT_ID=vpp-consumer-platform
KEYCLOAK_CLIENT_SECRET=<secure-secret>
```

### Security Checklist

- [ ] Enable TLS for all middleware connections
- [ ] Use strong passwords for Redis, Kafka, Keycloak
- [ ] Configure Kafka ACLs for topic access control
- [ ] Enable Keycloak mTLS for worker-server communication
- [ ] Use secrets management (AWS Secrets Manager, HashiCorp Vault)
- [ ] Enable audit logging for all middleware
- [ ] Configure network policies to restrict access
- [ ] Enable encryption at rest for Kafka and Redis

### High Availability

**Kafka Cluster:**
- 3+ brokers
- Replication factor: 3
- Min in-sync replicas: 2

**Temporal Cluster:**
- Multiple workers (2-4 per task queue)
- Database persistence (PostgreSQL with replication)
- Separate task queues by priority

**Redis Cluster:**
- Master-replica setup (1 master + 2 replicas)
- Sentinel for automatic failover
- Persistence enabled (AOF + RDB)

### Scaling

**Temporal Workers:**

```bash
# Scale workers horizontally
pm2 scale vpp-worker 4
```

**Kafka Consumers (ETL):**

Run multiple ETL instances with same `KAFKA_GROUP_ID` for parallel processing.

**Redis:**

Use Redis Cluster mode for horizontal scaling:

```bash
REDIS_CLUSTER_ENABLED=true
REDIS_CLUSTER_NODES=redis1:6379,redis2:6379,redis3:6379
```

## 8. Troubleshooting

### Temporal Issues

**Worker not connecting:**

```bash
# Check Temporal server
docker logs nextgen_temporal

# Test connection
tctl cluster health

# Check worker logs
pm2 logs vpp-worker
```

**Workflow stuck:**

```bash
# View workflow in UI
# http://localhost:8233

# Describe workflow
tctl workflow describe -w <workflow-id>

# Cancel workflow
tctl workflow cancel -w <workflow-id>
```

### Kafka Issues

**Messages not publishing:**

```bash
# Check Kafka broker
docker logs nextgen_kafka

# Test connection
docker exec -it nextgen_kafka kafka-broker-api-versions \
  --bootstrap-server localhost:9092

# Check topic
docker exec -it nextgen_kafka kafka-topics \
  --bootstrap-server localhost:9092 \
  --describe --topic vpp.payments.initiated
```

### Redis Issues

**Cache not working:**

```bash
# Test connection
redis-cli -h localhost -p 6379 ping

# Check memory
redis-cli -h localhost -p 6379 info memory

# Monitor commands
redis-cli -h localhost -p 6379 monitor
```

### Keycloak Issues

**Authentication failing:**

```bash
# Check Keycloak logs
docker logs nextgen_keycloak

# Test realm
curl http://localhost:8080/realms/vpp-platform

# Verify client configuration in Keycloak admin console
```

## 9. Maintenance

### Backup

**Temporal:**
```bash
# Backup PostgreSQL database
pg_dump temporal > temporal_backup.sql
```

**Redis:**
```bash
# Trigger RDB snapshot
redis-cli -h localhost -p 6379 bgsave

# Copy dump file
cp /var/lib/redis/dump.rdb /backup/redis_$(date +%Y%m%d).rdb
```

**Kafka:**
```bash
# Use MirrorMaker 2 for replication
# Or backup Zookeeper and Kafka data directories
```

### Updates

**Temporal SDK:**
```bash
pnpm update @temporalio/worker @temporalio/workflow @temporalio/client
```

**Python Dependencies:**
```bash
pip install --upgrade -r requirements.txt
```

### Monitoring

Set up alerts for:
- Temporal workflow failures
- Kafka consumer lag
- Redis memory usage > 80%
- Keycloak authentication failures
- ETL pipeline errors

## Support

For issues or questions:
- **Temporal**: http://localhost:8233 (Web UI)
- **Kafka**: Check NextGen platform logs
- **Redis**: Use cache monitoring dashboard
- **Keycloak**: http://localhost:8080 (Admin console)
- **Documentation**: `docs/MIDDLEWARE_INTEGRATION_V18.md`
