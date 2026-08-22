# Temporal Workers Deployment

This directory contains Temporal workers for executing VPP platform workflows.

## Workers

### 1. DR Event Worker (Go)
- **Language**: Go
- **Task Queue**: `dr-events`
- **Purpose**: Orchestrates demand response events
- **Features**:
  - Participant enrollment
  - Event notifications
  - Compliance monitoring
  - Compensation calculation

### 2. Trading Worker (Python)
- **Language**: Python
- **Task Queue**: `trading-execution`
- **Purpose**: Executes automated and P2P energy trading
- **Features**:
  - Automated trading strategies
  - P2P trading with escrow
  - Market making
  - Order matching

### 3. Payment Worker (Python)
- **Language**: Python
- **Task Queue**: `payment-processing`
- **Purpose**: Processes payments with retry logic
- **Features**:
  - Multi-gateway support (M-Pesa, Airtel, Tigo)
  - Automatic retries
  - Payment verification
  - Audit logging

## Prerequisites

- Docker and Docker Compose
- Database connection (PostgreSQL)
- Temporal Server (included in docker-compose)

## Environment Variables

Create a `.env` file in the `workers` directory:

```env
# Database Configuration
DATABASE_URL=postgresql://user:password@host:port/database
DB_HOST=localhost
DB_NAME=vpp_platform
DB_USER=root
DB_PASSWORD=your_password

# Temporal Configuration
TEMPORAL_ADDRESS=temporal:7233
```

## Local Development

### Start all workers with Temporal server:

```bash
cd workers
docker-compose up
```

This will start:
- Temporal server with PostgreSQL
- DR Event worker
- Trading worker
- Payment worker

### Build individual workers:

**DR Worker (Go):**
```bash
cd dr-worker
go mod download
go build -o dr-worker main.go
./dr-worker
```

**Trading Worker (Python):**
```bash
cd trading-worker
pip install -r requirements.txt
python main.py
```

**Payment Worker (Python):**
```bash
cd payment-worker
pip install -r requirements.txt
python main.py
```

## Production Deployment

### Option 1: Docker Compose

```bash
docker-compose up -d
```

### Option 2: Kubernetes

Deploy each worker as a separate deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dr-worker
spec:
  replicas: 3
  selector:
    matchLabels:
      app: dr-worker
  template:
    metadata:
      labels:
        app: dr-worker
    spec:
      containers:
      - name: dr-worker
        image: vpp-dr-worker:latest
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: vpp-secrets
              key: database-url
        - name: TEMPORAL_ADDRESS
          value: "temporal.default.svc.cluster.local:7233"
```

### Option 3: Systemd Services

Create systemd service files for each worker:

```ini
[Unit]
Description=VPP DR Event Worker
After=network.target

[Service]
Type=simple
User=vpp
WorkingDirectory=/opt/vpp/workers/dr-worker
Environment="DATABASE_URL=postgresql://..."
Environment="TEMPORAL_ADDRESS=localhost:7233"
ExecStart=/opt/vpp/workers/dr-worker/dr-worker
Restart=always

[Install]
WantedBy=multi-user.target
```

## Monitoring

### Worker Health Checks

Workers expose health endpoints:
- DR Worker: Check process status
- Python Workers: Built-in Temporal worker metrics

### Temporal UI

Access Temporal UI at: http://localhost:8080

View:
- Workflow executions
- Task queues
- Worker status
- Execution history

### Logs

View worker logs:
```bash
docker-compose logs -f dr-worker
docker-compose logs -f trading-worker
docker-compose logs -f payment-worker
```

## Scaling

### Horizontal Scaling

Add more worker instances:

```bash
docker-compose up --scale dr-worker=3 --scale trading-worker=5 --scale payment-worker=3
```

### Worker Configuration

Adjust concurrency in worker code:
- Go: `worker.Options{MaxConcurrentActivityExecutionSize: 100}`
- Python: Worker automatically manages concurrency

## Troubleshooting

### Worker not connecting to Temporal

Check Temporal server status:
```bash
docker-compose ps temporal
docker-compose logs temporal
```

### Database connection errors

Verify database credentials and network connectivity:
```bash
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -U $DB_USER -d $DB_NAME
```

### Worker crashes

Check logs for errors:
```bash
docker-compose logs --tail=100 dr-worker
```

## Testing Workflows

### Start a DR Event Workflow

```bash
temporal workflow start \
  --task-queue dr-events \
  --type DREventWorkflow \
  --input '{"eventId": 1, "startTime": "2024-01-01T10:00:00Z", "endTime": "2024-01-01T12:00:00Z", "targetKw": 100, "compensationRate": 50, "autoEnroll": true}'
```

### Start a Trading Workflow

```bash
temporal workflow start \
  --task-queue trading-execution \
  --type AutomatedTradingWorkflow \
  --input '{"user_id": 1, "asset_id": 1, "strategy": "sell_excess", "min_price": 40}'
```

### Start a Payment Workflow

```bash
temporal workflow start \
  --task-queue payment-processing \
  --type PaymentProcessingWorkflow \
  --input '{"payment_id": 1, "user_id": 1, "amount": 1000, "gateway": "mpesa", "phone_number": "254712345678", "account_reference": "INV-001"}'
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Temporal Server                       │
│                  (Workflow Orchestration)                │
└────────────┬────────────────┬────────────────┬──────────┘
             │                │                │
    ┌────────▼────────┐ ┌────▼─────────┐ ┌───▼──────────┐
    │   DR Worker     │ │Trading Worker│ │Payment Worker│
    │     (Go)        │ │   (Python)   │ │   (Python)   │
    └────────┬────────┘ └────┬─────────┘ └───┬──────────┘
             │                │                │
             └────────────────┴────────────────┘
                             │
                    ┌────────▼─────────┐
                    │   PostgreSQL     │
                    │    Database      │
                    └──────────────────┘
```

## Best Practices

1. **Resource Limits**: Set appropriate CPU/memory limits for each worker
2. **Error Handling**: All activities should handle errors gracefully
3. **Idempotency**: Activities should be idempotent for safe retries
4. **Monitoring**: Monitor workflow execution times and failure rates
5. **Versioning**: Version workflows when making breaking changes
6. **Testing**: Test workflows in staging before production deployment
