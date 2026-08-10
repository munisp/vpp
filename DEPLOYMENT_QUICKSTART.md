# VPP Platform Deployment Quickstart Guide

This guide will help you deploy the complete VPP Consumer Platform with all external services and the Temporal orchestrator in under 30 minutes.

## Prerequisites

Before starting, ensure you have:

- **Docker** (v20.10+) and **Docker Compose** (v2.0+)
- **Go** (v1.21+) for building the orchestrator
- **Node.js** (v18+) and **pnpm** for the web application
- At least **8GB RAM** and **20GB disk space**
- **Linux or macOS** (Windows requires WSL2)

## Quick Start (5 Steps)

### Step 1: Start External Services (5 minutes)

```bash
# Start all external services with Docker Compose
./scripts/start-external-services.sh
```

This will start:
- **Temporal Server** (port 7233) + Web UI (port 8233)
- **Kafka** (port 29092) + Kafka UI (port 8090)
- **Redis** (port 6379) + Redis Commander (port 8091)
- **Keycloak** (port 8080)
- **TigerBeetle** (port 3000)
- **Dapr** (port 50005)
- **Fluvio** (port 9003)

**Wait 2-3 minutes** for all services to be healthy.

### Step 2: Configure Services (3 minutes)

```bash
# Setup Keycloak realm and get client secret
./scripts/setup-keycloak.sh

# Initialize TigerBeetle ledger
./scripts/init-tigerbeetle.sh

# Create Kafka topics
./scripts/create-kafka-topics.sh
```

**Important:** Save the Keycloak client secret displayed by `setup-keycloak.sh` - you'll need it in Step 4.

### Step 3: Build Orchestrator (2 minutes)

```bash
# Build the Go orchestrator service
./scripts/build-orchestrator.sh
```

This creates the `orchestrator/vpp-orchestrator` binary.

### Step 4: Configure Orchestrator Environment

The orchestrator needs environment variables to connect to all services. You'll configure these through the Manus platform secrets management.

**Required Environment Variables:**

```bash
# Temporal Configuration
TEMPORAL_HOST=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=vpp-workflows

# Kafka Configuration
KAFKA_BROKERS=localhost:29092
KAFKA_TOPIC_PREFIX=vpp

# Redis Configuration
REDIS_HOST=localhost:6379
REDIS_PASSWORD=vpp-redis-password
REDIS_DB=0

# Keycloak Configuration
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=vpp-platform
KEYCLOAK_CLIENT_ID=vpp-orchestrator
KEYCLOAK_CLIENT_SECRET=<from-step-2>

# TigerBeetle Configuration
TIGERBEETLE_CLUSTER_ID=0
TIGERBEETLE_ADDRESSES=localhost:3000

# Dapr Configuration
DAPR_HTTP_PORT=3500
DAPR_GRPC_PORT=50001
DAPR_PLACEMENT_HOST=localhost:50005

# Fluvio Configuration
FLUVIO_CLUSTER=localhost:9003
FLUVIO_TOPIC_PREFIX=vpp

# Orchestrator Configuration
ORCHESTRATOR_PORT=8080
ORCHESTRATOR_LOG_LEVEL=info
ORCHESTRATOR_WORKER_CONCURRENCY=10
```

### Step 5: Start Orchestrator (1 minute)

```bash
# Start the orchestrator service
cd orchestrator
./vpp-orchestrator
```

The orchestrator will:
1. Connect to Temporal Server
2. Register all workflows and activities
3. Start listening for workflow triggers
4. Begin processing workflows

## Verify Deployment

### Check Service Health

```bash
# Check all services are running
docker ps

# Expected output: 13 containers running
# - temporal, temporal-postgresql, temporal-web
# - kafka, zookeeper, kafka-ui
# - redis, redis-commander
# - keycloak, keycloak-postgres
# - tigerbeetle, dapr-placement, dapr-redis, fluvio
```

### Access Web UIs

Open these URLs in your browser:

- **Temporal Web UI**: http://localhost:8233
- **Kafka UI**: http://localhost:8090
- **Redis Commander**: http://localhost:8091
- **Keycloak Admin**: http://localhost:8080 (admin/admin)

### Test Workflow Execution

```bash
# From the web application, trigger a workflow via tRPC
# Example: Start auto-trading workflow

curl -X POST http://localhost:3000/api/trpc/orchestrator.startAutoTrading \
  -H "Content-Type: application/json" \
  -d '{"assetId": "solar-panel-1"}'
```

Check Temporal Web UI to see the workflow execution.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    VPP Web Application                       │
│                   (Node.js + React PWA)                      │
│                     Port: 3000                               │
└────────────────────────┬────────────────────────────────────┘
                         │ tRPC API
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Orchestrator tRPC Bridge                        │
│            (server/routers/orchestrator.ts)                  │
└────────────────────────┬────────────────────────────────────┘
                         │ Workflow Triggers
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              VPP Orchestrator Service                        │
│                  (Go + Temporal)                             │
│                  Port: 8080                                  │
└────────────┬────────────────────────────────────────────────┘
             │
             ├──▶ Temporal Server (port 7233)
             ├──▶ Kafka (port 29092)
             ├──▶ Redis (port 6379)
             ├──▶ Keycloak (port 8080)
             ├──▶ TigerBeetle (port 3000)
             ├──▶ Dapr (port 50005)
             └──▶ Fluvio (port 9003)
```

## Available Workflows

Once deployed, you can trigger these workflows via the tRPC API:

### Trading Workflows
- `orchestrator.startAutoTrading` - Automatic energy trading
- `orchestrator.startManualTrade` - Manual energy purchase
- `orchestrator.startP2PTrade` - Peer-to-peer energy trading

### Demand Response Workflows
- `orchestrator.enrollInDREvent` - Enroll in DR event
- `orchestrator.startDRForecasting` - Start DR forecasting (admin)

### Payment Workflows
- `orchestrator.processPayment` - Process mobile money payment
- `orchestrator.processQRPayment` - Process QR code payment

### Monitoring Workflows
- `orchestrator.startTelemetryMonitoring` - Start device monitoring
- `orchestrator.processAlert` - Process system alert

### Gamification Workflows
- `orchestrator.updateLeaderboard` - Update leaderboard (admin)
- `orchestrator.trackAchievement` - Track user achievement

### Workflow Management
- `orchestrator.getWorkflowStatus` - Get workflow status
- `orchestrator.listUserWorkflows` - List user's workflows
- `orchestrator.cancelWorkflow` - Cancel running workflow

## Monitoring

### View Workflow Executions

**Temporal Web UI**: http://localhost:8233
- View all workflow executions
- See workflow history and events
- Debug failed workflows
- Replay workflows

### View Event Streams

**Kafka UI**: http://localhost:8090
- Monitor Kafka topics
- View message throughput
- Inspect message payloads
- Monitor consumer lag

### View Cache Data

**Redis Commander**: http://localhost:8091
- Browse cached data
- Monitor cache hit rates
- View TTL expiration
- Inspect key patterns

### View Logs

```bash
# Orchestrator logs
tail -f orchestrator/logs/orchestrator.log

# Docker service logs
docker-compose -f docker-compose.external-services.yml logs -f [service-name]

# Examples:
docker-compose -f docker-compose.external-services.yml logs -f temporal
docker-compose -f docker-compose.external-services.yml logs -f kafka
docker-compose -f docker-compose.external-services.yml logs -f redis
```

## Troubleshooting

### Services Not Starting

```bash
# Check Docker resources
docker system df

# Restart all services
docker-compose -f docker-compose.external-services.yml restart

# View service logs
docker-compose -f docker-compose.external-services.yml logs [service-name]
```

### Orchestrator Connection Issues

```bash
# Test Temporal connection
curl http://localhost:7233/health

# Test Kafka connection
docker exec kafka kafka-broker-api-versions --bootstrap-server localhost:9092

# Test Redis connection
docker exec redis redis-cli -a vpp-redis-password ping

# Test Keycloak connection
curl http://localhost:8080/health/ready
```

### Workflow Not Executing

1. **Check Temporal Web UI** - Verify workflow is registered
2. **Check orchestrator logs** - Look for connection errors
3. **Verify task queue** - Ensure orchestrator is polling correct queue
4. **Check activity errors** - View activity execution history

### Port Conflicts

If ports are already in use, modify `docker-compose.external-services.yml`:

```yaml
services:
  temporal:
    ports:
      - "7234:7233"  # Change external port
```

## Stopping Services

```bash
# Stop orchestrator
# Press Ctrl+C in orchestrator terminal

# Stop all Docker services
docker-compose -f docker-compose.external-services.yml down

# Stop and remove volumes (WARNING: deletes all data)
docker-compose -f docker-compose.external-services.yml down -v
```

## Production Deployment

For production deployment:

1. **Use managed services** - Replace Docker containers with managed services (AWS MSK for Kafka, ElastiCache for Redis, etc.)
2. **Enable TLS** - Configure TLS for all service connections
3. **Setup monitoring** - Deploy Prometheus + Grafana for metrics
4. **Configure backups** - Setup automated backups for databases
5. **Scale orchestrator** - Run multiple orchestrator instances for high availability
6. **Use secrets manager** - Store credentials in AWS Secrets Manager or HashiCorp Vault

See `docs/ORCHESTRATOR_DEPLOYMENT.md` for detailed production deployment guide.

## Next Steps

1. **Configure mobile money gateways** - Setup M-Pesa, Airtel Money, Tigo Pesa credentials
2. **Deploy IoT devices** - Connect smart meters and inverters via MQTT
3. **Setup monitoring dashboards** - Create Grafana dashboards for system metrics
4. **Configure DR events** - Setup demand response events for grid operators
5. **Test end-to-end flows** - Verify complete user journeys from registration to trading

## Support

For issues or questions:

- **Documentation**: `/docs/` directory
- **Temporal Docs**: https://docs.temporal.io
- **Kafka Docs**: https://kafka.apache.org/documentation/
- **Keycloak Docs**: https://www.keycloak.org/documentation

## Summary

You now have a fully functional VPP Consumer Platform with:

✅ **14 Temporal workflows** orchestrating complex user journeys  
✅ **50+ activities** integrating 6 middleware services  
✅ **Event-driven architecture** with Kafka and Fluvio  
✅ **Financial ledger** with TigerBeetle  
✅ **Authentication** with Keycloak  
✅ **Caching** with Redis  
✅ **Service mesh** with Dapr  
✅ **Real-time monitoring** with Temporal Web UI  

Your platform is ready to handle energy trading, demand response, payments, and gamification at scale!
