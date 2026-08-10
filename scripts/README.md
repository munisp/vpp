# VPP Platform Deployment Scripts

This directory contains automated deployment scripts for the VPP Consumer Platform external services and orchestrator.

## Scripts Overview

### 1. start-external-services.sh
**Purpose**: Start all external services using Docker Compose

**What it does**:
- Validates Docker and Docker Compose installation
- Creates necessary configuration directories
- Starts 13 Docker containers for all middleware services
- Performs health checks on all services
- Displays service URLs and next steps

**Usage**:
```bash
./scripts/start-external-services.sh
```

**Services Started**:
- Temporal Server + PostgreSQL + Web UI
- Kafka + Zookeeper + Kafka UI
- Redis + Redis Commander
- Keycloak + PostgreSQL
- TigerBeetle
- Dapr Placement + Redis
- Fluvio

**Ports**:
- 7233: Temporal Server
- 8233: Temporal Web UI
- 29092: Kafka
- 8090: Kafka UI
- 6379: Redis
- 8091: Redis Commander
- 8080: Keycloak
- 3000: TigerBeetle
- 50005: Dapr Placement
- 9003: Fluvio

### 2. setup-keycloak.sh
**Purpose**: Configure Keycloak with VPP realm and orchestrator client

**What it does**:
- Waits for Keycloak to be ready
- Obtains admin access token
- Creates `vpp-platform` realm
- Creates `vpp-orchestrator` client
- Generates and displays client secret

**Usage**:
```bash
./scripts/setup-keycloak.sh
```

**Output**:
- Keycloak client ID: `vpp-orchestrator`
- Keycloak client secret: (displayed in terminal)

**Important**: Save the client secret for orchestrator configuration.

### 3. init-tigerbeetle.sh
**Purpose**: Initialize TigerBeetle ledger database

**What it does**:
- Checks if TigerBeetle container is running
- Creates cluster data file if not exists
- Verifies TigerBeetle connectivity

**Usage**:
```bash
./scripts/init-tigerbeetle.sh
```

**Note**: This only needs to be run once during initial setup.

### 4. create-kafka-topics.sh
**Purpose**: Create all required Kafka topics for VPP platform

**What it does**:
- Creates 16 Kafka topics with 3 partitions each
- Lists all created topics

**Usage**:
```bash
./scripts/create-kafka-topics.sh
```

**Topics Created**:
- vpp.trading.orders
- vpp.trading.executions
- vpp.trading.p2p
- vpp.dr.events
- vpp.dr.participation
- vpp.dr.forecasts
- vpp.payments.transactions
- vpp.payments.receipts
- vpp.telemetry.raw
- vpp.telemetry.processed
- vpp.alerts.system
- vpp.alerts.user
- vpp.gamification.achievements
- vpp.gamification.leaderboard
- vpp.notifications.push
- vpp.workflows.events

### 5. build-orchestrator.sh
**Purpose**: Build the Go orchestrator service

**What it does**:
- Validates Go installation
- Downloads Go dependencies
- Runs tests
- Builds optimized binary
- Verifies build success

**Usage**:
```bash
./scripts/build-orchestrator.sh
```

**Output**: `orchestrator/vpp-orchestrator` binary

## Deployment Workflow

### First-Time Setup

Run scripts in this order:

```bash
# 1. Start all external services
./scripts/start-external-services.sh

# Wait 2-3 minutes for services to be healthy

# 2. Configure Keycloak
./scripts/setup-keycloak.sh
# Save the client secret displayed

# 3. Initialize TigerBeetle
./scripts/init-tigerbeetle.sh

# 4. Create Kafka topics
./scripts/create-kafka-topics.sh

# 5. Build orchestrator
./scripts/build-orchestrator.sh

# 6. Configure orchestrator environment variables
# (Use Manus platform secrets management)

# 7. Start orchestrator
cd orchestrator
./vpp-orchestrator
```

### Subsequent Runs

After initial setup, you only need:

```bash
# Start services
./scripts/start-external-services.sh

# Start orchestrator
cd orchestrator
./vpp-orchestrator
```

## Troubleshooting

### Script Permission Denied

```bash
chmod +x scripts/*.sh
```

### Docker Not Found

Install Docker:
- **Linux**: https://docs.docker.com/engine/install/
- **macOS**: https://docs.docker.com/desktop/install/mac-install/
- **Windows**: https://docs.docker.com/desktop/install/windows-install/

### Port Already in Use

Check what's using the port:
```bash
lsof -i :7233  # Example for Temporal port
```

Kill the process or modify `docker-compose.external-services.yml` to use different ports.

### Service Not Healthy

View service logs:
```bash
docker-compose -f docker-compose.external-services.yml logs [service-name]
```

Restart specific service:
```bash
docker-compose -f docker-compose.external-services.yml restart [service-name]
```

### Go Build Fails

Ensure Go 1.21+ is installed:
```bash
go version
```

Clean and rebuild:
```bash
cd orchestrator
go clean
go mod tidy
go build
```

## Maintenance

### View Service Logs

```bash
# All services
docker-compose -f docker-compose.external-services.yml logs -f

# Specific service
docker-compose -f docker-compose.external-services.yml logs -f temporal
docker-compose -f docker-compose.external-services.yml logs -f kafka
docker-compose -f docker-compose.external-services.yml logs -f redis
```

### Stop Services

```bash
# Stop all services
docker-compose -f docker-compose.external-services.yml down

# Stop and remove volumes (WARNING: deletes data)
docker-compose -f docker-compose.external-services.yml down -v
```

### Restart Services

```bash
# Restart all services
docker-compose -f docker-compose.external-services.yml restart

# Restart specific service
docker-compose -f docker-compose.external-services.yml restart temporal
```

### Update Services

```bash
# Pull latest images
docker-compose -f docker-compose.external-services.yml pull

# Restart with new images
docker-compose -f docker-compose.external-services.yml up -d
```

## Production Considerations

These scripts are designed for **development and testing**. For production:

1. **Use managed services** - Replace Docker containers with cloud-managed services
2. **Enable TLS** - Configure SSL/TLS for all connections
3. **Setup monitoring** - Deploy Prometheus + Grafana
4. **Configure backups** - Automated database backups
5. **Use secrets manager** - AWS Secrets Manager, HashiCorp Vault
6. **Setup CI/CD** - Automated deployment pipeline
7. **Configure logging** - Centralized log aggregation
8. **Setup alerting** - PagerDuty, Opsgenie integration

See `docs/ORCHESTRATOR_DEPLOYMENT.md` for production deployment guide.

## Environment Variables

The orchestrator requires these environment variables (configured via Manus platform):

```bash
# Temporal
TEMPORAL_HOST=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=vpp-workflows

# Kafka
KAFKA_BROKERS=localhost:29092
KAFKA_TOPIC_PREFIX=vpp

# Redis
REDIS_HOST=localhost:6379
REDIS_PASSWORD=vpp-redis-password
REDIS_DB=0

# Keycloak
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=vpp-platform
KEYCLOAK_CLIENT_ID=vpp-orchestrator
KEYCLOAK_CLIENT_SECRET=<from-setup-keycloak.sh>

# TigerBeetle
TIGERBEETLE_CLUSTER_ID=0
TIGERBEETLE_ADDRESSES=localhost:3000

# Dapr
DAPR_HTTP_PORT=3500
DAPR_GRPC_PORT=50001
DAPR_PLACEMENT_HOST=localhost:50005

# Fluvio
FLUVIO_CLUSTER=localhost:9003
FLUVIO_TOPIC_PREFIX=vpp

# Orchestrator
ORCHESTRATOR_PORT=8080
ORCHESTRATOR_LOG_LEVEL=info
ORCHESTRATOR_WORKER_CONCURRENCY=10
```

## Support

For issues or questions:
- Check `DEPLOYMENT_QUICKSTART.md` for step-by-step guide
- Review `docs/ORCHESTRATOR_DEPLOYMENT.md` for detailed documentation
- View service logs for error messages
- Check Docker container health status

## Quick Reference

| Service | Port | UI URL | Credentials |
|---------|------|--------|-------------|
| Temporal | 7233 | http://localhost:8233 | - |
| Kafka | 29092 | http://localhost:8090 | - |
| Redis | 6379 | http://localhost:8091 | vpp-redis-password |
| Keycloak | 8080 | http://localhost:8080 | admin/admin |
| TigerBeetle | 3000 | - | - |
| Dapr | 50005 | - | - |
| Fluvio | 9003 | - | - |
