# VPP Platform Orchestrator

Temporal-based orchestration layer for 30 user stories/journeys with full middleware integration.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Temporal Orchestrator                     │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Workflows   │  │  Activities  │  │   Services   │     │
│  │              │  │              │  │              │     │
│  │ • Onboarding │  │ • Create     │  │ • Kafka      │     │
│  │ • Trading    │  │ • Validate   │  │ • Dapr       │     │
│  │ • DR Events  │  │ • Process    │  │ • Redis      │     │
│  │ • Payments   │  │ • Notify     │  │ • Keycloak   │     │
│  │ • Monitoring │  │ • Publish    │  │ • Permify    │     │
│  │ • Gamify     │  │              │  │ • TigerBeetle│     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Middleware Stack                          │
│                                                              │
│  Kafka    Dapr    Fluvio   Keycloak  Permify  Redis        │
│  APISix   TigerBeetle      Lakehouse                        │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    VPP Platform                              │
│                                                              │
│  tRPC API    Database    PWA    Mobile App                  │
└─────────────────────────────────────────────────────────────┘
```

## Features

### 30 User Stories Orchestrated

1. **Onboarding** (US-001 to US-005)
   - User registration & asset onboarding
   - Payment method setup
   - Contract signing
   - Notification preferences
   - Device IoT integration

2. **Trading** (US-006 to US-010)
   - Automatic energy export
   - Manual energy purchase
   - P2P trading
   - Trading analytics
   - Auto-trading rules

3. **Demand Response** (US-011 to US-015)
   - DR event participation
   - DR forecasting
   - DR segmentation
   - Performance tracking
   - Emergency response

4. **Payments** (US-016 to US-020)
   - Mobile money processing
   - QR code payments
   - Billing & invoices
   - Payment reconciliation
   - Multi-currency support

5. **Monitoring** (US-021 to US-025)
   - Real-time telemetry
   - Performance analytics
   - Alert management
   - Data export
   - Admin analytics

6. **Gamification** (US-026 to US-030)
   - Leaderboard competition
   - Achievement unlocking
   - Social sharing
   - Community challenges
   - Referral program

### Middleware Integration

- **Kafka**: Event streaming for all user actions
- **Dapr**: Service-to-service invocation and state management
- **Fluvio**: Real-time telemetry streaming
- **Keycloak**: OAuth authentication and SSO
- **Permify**: Fine-grained authorization (RBAC/ABAC)
- **Redis**: Caching, sessions, rate limiting
- **APISix**: API gateway, routing, throttling
- **TigerBeetle**: Financial ledger and transactions
- **Lakehouse**: Historical data and analytics

## Setup

### Prerequisites

- Go 1.21+
- Temporal Server running
- Kafka cluster
- Redis instance
- All middleware services configured

### Environment Variables

```bash
# Temporal
TEMPORAL_HOST_PORT=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=vpp-orchestrator

# Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_GROUP_ID=vpp-orchestrator

# Dapr
DAPR_HTTP_PORT=3500
DAPR_GRPC_PORT=50001

# Fluvio
FLUVIO_ENDPOINT=localhost:9003

# Keycloak
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=vpp-platform
KEYCLOAK_CLIENT_ID=vpp-orchestrator
KEYCLOAK_CLIENT_SECRET=<secret>

# Permify
PERMIFY_ENDPOINT=localhost:3476
PERMIFY_API_KEY=<api-key>

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=<password>

# APISix
APISIX_ADMIN_URL=http://localhost:9180
APISIX_API_KEY=<api-key>

# TigerBeetle
TIGERBEETLE_REPLICAS=localhost:3000

# Lakehouse
LAKEHOUSE_ENDPOINT=http://localhost:9000
LAKEHOUSE_BUCKET=vpp-data

# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=<password>
DB_NAME=vpp_platform
```

### Installation

```bash
cd orchestrator

# Install dependencies
go mod download

# Build
go build -o orchestrator

# Run
./orchestrator
```

## Development

### Adding New Workflows

1. Create workflow file in `workflows/`
2. Implement workflow function
3. Register in `workflows/workflows.go`
4. Create activities in `activities/`
5. Test end-to-end

### Testing

```bash
# Run tests
go test ./...

# Run with coverage
go test -cover ./...
```

## Deployment

### Docker

```bash
docker build -t vpp-orchestrator .
docker run -d --name vpp-orchestrator \
  --env-file .env \
  vpp-orchestrator
```

### Kubernetes

```bash
kubectl apply -f k8s/orchestrator-deployment.yaml
```

## Monitoring

- Temporal UI: http://localhost:8080
- Workflow metrics: Prometheus + Grafana
- Logs: Structured JSON logging

## Documentation

- [User Stories](../docs/USER_STORIES.md) - Complete list of 30 user stories
- [Middleware Integration](../docs/MIDDLEWARE_INTEGRATION_V19.md) - Middleware architecture
- [Deployment Guide](../docs/MIDDLEWARE_DEPLOYMENT_GUIDE.md) - Production deployment

## License

Proprietary - VPP Platform
