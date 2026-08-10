# VPP Orchestrator Deployment Guide

## Overview

The VPP Orchestrator is a Go-based service that implements Temporal workflows for orchestrating complex user journeys across the VPP Consumer Platform. It integrates with multiple middleware services including Kafka, Redis, Keycloak, TigerBeetle, Dapr, and Fluvio.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     VPP Consumer Platform                        │
│  ┌──────────────┐         ┌──────────────┐                     │
│  │   Web PWA    │────────▶│  tRPC API    │                     │
│  └──────────────┘         │  (Node.js)   │                     │
│  ┌──────────────┐         └──────┬───────┘                     │
│  │ Mobile App   │────────────────┘                              │
│  └──────────────┘                 │                             │
└────────────────────────────────────┼─────────────────────────────┘
                                     │
                                     ▼
                          ┌──────────────────┐
                          │ Orchestrator API │
                          │  (tRPC Bridge)   │
                          └────────┬─────────┘
                                   │
                                   ▼
                    ┌──────────────────────────┐
                    │   Temporal Workflows     │
                    │      (Go Service)        │
                    └────────┬─────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
   ┌─────────┐         ┌─────────┐        ┌─────────┐
   │  Kafka  │         │  Redis  │        │ Keycloak│
   └─────────┘         └─────────┘        └─────────┘
         │                   │                   │
         ▼                   ▼                   ▼
   ┌─────────┐         ┌─────────┐        ┌─────────┐
   │ Fluvio  │         │  Dapr   │        │TigerBtl │
   └─────────┘         └─────────┘        └─────────┘
```

## Implemented Workflows

### Onboarding Workflows (3)
1. **User Registration** - Complete user profile setup with validation
2. **Asset Registration** - Register solar panels, batteries, inverters
3. **Payment Setup** - Configure mobile money payment methods

### Trading Workflows (3)
4. **Auto Trading** - Automatic energy export based on surplus
5. **Manual Trading** - User-initiated energy purchase
6. **P2P Trading** - Peer-to-peer energy trading

### Demand Response Workflows (2)
7. **DR Event Participation** - Enroll and participate in DR events
8. **DR Forecasting** - Predict optimal DR event timing

### Payment Workflows (2)
9. **Payment Processing** - Mobile money payment processing
10. **QR Payment** - QR code-based payments

### Monitoring Workflows (2)
11. **Telemetry Monitoring** - Continuous IoT device monitoring
12. **Alert Management** - System alert processing

### Gamification Workflows (2)
13. **Leaderboard Update** - Update global/weekly leaderboards
14. **Achievement Tracking** - Track and award achievements

**Total: 14 Workflows Implemented**

## Directory Structure

```
orchestrator/
├── main.go                    # Main entry point
├── go.mod                     # Go module dependencies
├── config/
│   └── config.go             # Configuration management
├── workflows/
│   ├── onboarding.go         # Onboarding workflows (3)
│   ├── trading.go            # Trading workflows (3)
│   ├── dr_events.go          # DR workflows (2)
│   └── payments_gamification.go  # Payment + gamification (6)
├── activities/
│   └── activities.go         # Activity implementations (50+)
└── services/
    ├── kafka.go              # Kafka event publishing
    ├── redis.go              # Redis caching
    ├── keycloak.go           # Keycloak authentication
    ├── tigerbeetle.go        # TigerBeetle ledger
    ├── dapr.go               # Dapr state management
    └── fluvio.go             # Fluvio streaming
```

## Prerequisites

### Required Services
- **Temporal Server** (v1.20+)
- **Kafka** (v3.0+) - Event streaming
- **Redis** (v7.0+) - Caching
- **Keycloak** (v21+) - Authentication
- **TigerBeetle** - Financial ledger
- **Dapr** (v1.10+) - State management
- **Fluvio** (v0.10+) - Real-time streaming

### Development Tools
- **Go** 1.21+
- **Docker** (optional, for containerized deployment)

## Environment Variables

Create a `.env` file in the orchestrator directory:

```bash
# Temporal Configuration
TEMPORAL_HOST=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=vpp-workflows

# Kafka Configuration
KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC_PREFIX=vpp

# Redis Configuration
REDIS_HOST=localhost:6379
REDIS_PASSWORD=
REDIS_DB=0

# Keycloak Configuration
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=vpp-platform
KEYCLOAK_CLIENT_ID=vpp-orchestrator
KEYCLOAK_CLIENT_SECRET=your-client-secret

# TigerBeetle Configuration
TIGERBEETLE_CLUSTER_ID=0
TIGERBEETLE_ADDRESSES=3000

# Dapr Configuration
DAPR_HTTP_PORT=3500
DAPR_GRPC_PORT=50001

# Fluvio Configuration
FLUVIO_CLUSTER=localhost:9003
FLUVIO_TOPIC_PREFIX=vpp
```

## Installation

### 1. Install Go Dependencies

```bash
cd orchestrator
go mod download
```

### 2. Build the Orchestrator

```bash
go build -o vpp-orchestrator
```

### 3. Run Tests

```bash
go test ./...
```

## Deployment Options

### Option 1: Direct Execution (Development)

```bash
cd orchestrator
./vpp-orchestrator
```

### Option 2: Systemd Service (Production)

Create `/etc/systemd/system/vpp-orchestrator.service`:

```ini
[Unit]
Description=VPP Orchestrator Service
After=network.target temporal.service

[Service]
Type=simple
User=vpp
WorkingDirectory=/opt/vpp-orchestrator
EnvironmentFile=/opt/vpp-orchestrator/.env
ExecStart=/opt/vpp-orchestrator/vpp-orchestrator
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable vpp-orchestrator
sudo systemctl start vpp-orchestrator
sudo systemctl status vpp-orchestrator
```

### Option 3: Docker Container

Create `Dockerfile`:

```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o vpp-orchestrator

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/vpp-orchestrator .
EXPOSE 8080
CMD ["./vpp-orchestrator"]
```

Build and run:

```bash
docker build -t vpp-orchestrator .
docker run -d --name vpp-orchestrator \
  --env-file .env \
  -p 8080:8080 \
  vpp-orchestrator
```

### Option 4: Kubernetes Deployment

Create `k8s-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpp-orchestrator
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vpp-orchestrator
  template:
    metadata:
      labels:
        app: vpp-orchestrator
    spec:
      containers:
      - name: orchestrator
        image: vpp-orchestrator:latest
        ports:
        - containerPort: 8080
        envFrom:
        - configMapRef:
            name: vpp-orchestrator-config
        - secretRef:
            name: vpp-orchestrator-secrets
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
---
apiVersion: v1
kind: Service
metadata:
  name: vpp-orchestrator
spec:
  selector:
    app: vpp-orchestrator
  ports:
  - port: 8080
    targetPort: 8080
  type: ClusterIP
```

Deploy:

```bash
kubectl apply -f k8s-deployment.yaml
```

## tRPC API Bridge

The orchestrator is integrated with the Node.js backend via tRPC. The bridge is located at:

```
server/routers/orchestrator.ts
```

### Available Endpoints

#### Trading
- `orchestrator.startAutoTrading` - Start auto-trading workflow
- `orchestrator.startManualTrade` - Start manual trading workflow
- `orchestrator.startP2PTrade` - Start P2P trading workflow

#### Demand Response
- `orchestrator.enrollInDREvent` - Enroll in DR event
- `orchestrator.startDRForecasting` - Start DR forecasting (admin only)

#### Payments
- `orchestrator.processPayment` - Process mobile money payment
- `orchestrator.processQRPayment` - Process QR code payment

#### Monitoring
- `orchestrator.startTelemetryMonitoring` - Start telemetry monitoring
- `orchestrator.processAlert` - Process system alert

#### Gamification
- `orchestrator.updateLeaderboard` - Update leaderboard (admin only)
- `orchestrator.trackAchievement` - Track achievement

#### Workflow Management
- `orchestrator.getWorkflowStatus` - Get workflow status
- `orchestrator.listUserWorkflows` - List user's workflows
- `orchestrator.cancelWorkflow` - Cancel running workflow

### Usage Example (Frontend)

```typescript
import { trpc } from '@/lib/trpc';

// Start auto-trading
const startAutoTrading = trpc.orchestrator.startAutoTrading.useMutation();

const handleStartAutoTrading = async (assetId: string) => {
  const result = await startAutoTrading.mutateAsync({ assetId });
  console.log('Workflow started:', result.workflowId);
};

// Get workflow status
const { data: workflows } = trpc.orchestrator.listUserWorkflows.useQuery();
```

## Monitoring

### Health Check

The orchestrator exposes a health check endpoint:

```bash
curl http://localhost:8080/health
```

Response:

```json
{
  "status": "healthy",
  "temporal": "connected",
  "kafka": "connected",
  "redis": "connected",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Metrics

Prometheus metrics are available at:

```bash
curl http://localhost:8080/metrics
```

Key metrics:
- `workflow_executions_total` - Total workflow executions
- `workflow_duration_seconds` - Workflow execution duration
- `activity_executions_total` - Total activity executions
- `middleware_calls_total` - Middleware service calls

### Logs

Logs are written to stdout in JSON format:

```json
{
  "level": "info",
  "timestamp": "2024-01-15T10:30:00Z",
  "workflow_id": "auto-trading-user123-asset456-1705315800",
  "message": "Workflow started successfully"
}
```

## Troubleshooting

### Workflow Not Starting

1. Check Temporal server connectivity:
```bash
temporal workflow list
```

2. Verify task queue:
```bash
temporal task-queue describe --task-queue vpp-workflows
```

3. Check orchestrator logs:
```bash
journalctl -u vpp-orchestrator -f
```

### Middleware Connection Issues

1. **Kafka**: Verify broker connectivity
```bash
kafka-topics.sh --bootstrap-server localhost:9092 --list
```

2. **Redis**: Test connection
```bash
redis-cli -h localhost -p 6379 ping
```

3. **Keycloak**: Check realm accessibility
```bash
curl http://localhost:8080/realms/vpp-platform
```

### Activity Failures

1. Check activity retry policy in workflow definition
2. Review activity logs for error details
3. Verify middleware service availability
4. Check network connectivity

## Scaling

### Horizontal Scaling

Run multiple orchestrator instances:

```bash
# Instance 1
TEMPORAL_WORKER_ID=worker-1 ./vpp-orchestrator

# Instance 2
TEMPORAL_WORKER_ID=worker-2 ./vpp-orchestrator

# Instance 3
TEMPORAL_WORKER_ID=worker-3 ./vpp-orchestrator
```

All instances will share the same task queue and distribute work automatically.

### Vertical Scaling

Increase worker concurrency in `config/config.go`:

```go
WorkerOptions: worker.Options{
    MaxConcurrentActivityExecutionSize: 100,
    MaxConcurrentWorkflowTaskExecutionSize: 50,
}
```

## Security

### TLS Configuration

Enable TLS for Temporal connection:

```go
clientOptions := client.Options{
    HostPort: "temporal.example.com:7233",
    ConnectionOptions: client.ConnectionOptions{
        TLS: &tls.Config{
            MinVersion: tls.VersionTLS12,
        },
    },
}
```

### Authentication

Use mTLS for Temporal authentication:

```go
cert, err := tls.LoadX509KeyPair("client.crt", "client.key")
tlsConfig := &tls.Config{
    Certificates: []tls.Certificate{cert},
}
```

### Secrets Management

Use environment variables or secrets manager:

```bash
# AWS Secrets Manager
aws secretsmanager get-secret-value --secret-id vpp-orchestrator

# HashiCorp Vault
vault kv get secret/vpp-orchestrator
```

## Performance Tuning

### Workflow Optimization

1. **Reduce activity count** - Combine related operations
2. **Use local activities** - For fast operations (<1s)
3. **Batch operations** - Process multiple items together
4. **Cache frequently accessed data** - Use Redis

### Activity Optimization

1. **Set appropriate timeouts** - Avoid unnecessary waits
2. **Implement idempotency** - Safe retries
3. **Use connection pooling** - Reuse connections
4. **Enable compression** - Reduce network overhead

## Maintenance

### Backup

Backup Temporal workflows:

```bash
temporal workflow backup --namespace default --output workflows.json
```

### Updates

1. Build new version:
```bash
go build -o vpp-orchestrator-v2
```

2. Test in staging:
```bash
./vpp-orchestrator-v2 --config staging.yaml
```

3. Rolling update:
```bash
# Stop old version
sudo systemctl stop vpp-orchestrator

# Deploy new version
sudo cp vpp-orchestrator-v2 /opt/vpp-orchestrator/vpp-orchestrator

# Start new version
sudo systemctl start vpp-orchestrator
```

### Database Migration

For workflow schema changes:

1. Deploy new version alongside old version
2. Gradually migrate workflows to new version
3. Deprecate old version after migration complete

## Support

For issues or questions:

- **Documentation**: `/docs/ORCHESTRATOR_DEPLOYMENT.md`
- **GitHub Issues**: https://github.com/vpp-platform/orchestrator/issues
- **Slack**: #vpp-orchestrator channel

## Next Steps

1. Deploy external services (Temporal, Kafka, Redis, etc.)
2. Configure environment variables
3. Build and deploy orchestrator
4. Test workflow execution
5. Monitor metrics and logs
6. Scale as needed

## Related Documentation

- [Middleware Integration Guide](./MIDDLEWARE_INTEGRATION_V19.md)
- [User Stories](./USER_STORIES.md)
- [Temporal Worker Deployment](./TEMPORAL_WORKER_DEPLOYMENT.md)
- [Production Deployment Checklist](./PRODUCTION_DEPLOYMENT_CHECKLIST.md)
