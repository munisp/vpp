# Temporal Worker Deployment Guide

## Overview

This guide provides instructions for deploying the Temporal worker process that handles payment workflows.

## Prerequisites

- Node.js 22.13.0+
- Temporal server running (NextGen VPP Platform)
- PM2 installed globally (`npm install -g pm2`)

## Deployment Options

### Option 1: Development Mode (Single Worker)

Run worker in development mode with auto-reload:

```bash
cd /home/ubuntu/vpp_consumer_platform
pnpm run worker:dev
```

This will:
- Start a single worker process
- Watch for file changes and auto-reload
- Output logs to console

### Option 2: Production Mode with PM2 (Recommended)

Deploy with PM2 for process management and clustering:

```bash
cd /home/ubuntu/vpp_consumer_platform
pnpm run pm2:start
```

This will start:
- **vpp-web**: Web server (1 instance)
- **vpp-temporal-worker**: Temporal worker (2 instances in cluster mode)

**PM2 Commands:**

```bash
# View status
pnpm run pm2:status

# View logs
pnpm run pm2:logs

# View logs for specific app
pm2 logs vpp-temporal-worker

# Restart all
pnpm run pm2:restart

# Stop all
pnpm run pm2:stop

# Delete all
pnpm run pm2:delete

# Monitor
pm2 monit
```

### Option 3: Systemd Service

Create systemd service for production deployment:

**1. Create service file `/etc/systemd/system/vpp-temporal-worker.service`:**

```ini
[Unit]
Description=VPP Temporal Worker
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/vpp_consumer_platform
Environment="NODE_ENV=production"
Environment="TEMPORAL_ADDRESS=localhost:7233"
Environment="TEMPORAL_NAMESPACE=default"
ExecStart=/usr/bin/node --import tsx server/workflows/worker.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vpp-worker

[Install]
WantedBy=multi-user.target
```

**2. Enable and start service:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable vpp-temporal-worker
sudo systemctl start vpp-temporal-worker
sudo systemctl status vpp-temporal-worker
```

**3. View logs:**

```bash
sudo journalctl -u vpp-temporal-worker -f
```

### Option 4: Docker Container

Create Dockerfile for worker:

```dockerfile
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Run worker
CMD ["node", "--import", "tsx", "server/workflows/worker.ts"]
```

Build and run:

```bash
docker build -t vpp-temporal-worker .
docker run -d \
  --name vpp-worker \
  --restart unless-stopped \
  -e TEMPORAL_ADDRESS=temporal:7233 \
  -e TEMPORAL_NAMESPACE=default \
  vpp-temporal-worker
```

## Configuration

### Environment Variables

```bash
# Temporal server address
TEMPORAL_ADDRESS=localhost:7233

# Temporal namespace
TEMPORAL_NAMESPACE=default

# TLS configuration (optional)
TEMPORAL_TLS_ENABLED=true
TEMPORAL_TLS_CERT_PATH=/path/to/cert.pem
TEMPORAL_TLS_KEY_PATH=/path/to/key.pem
TEMPORAL_TLS_CA_PATH=/path/to/ca.pem
TEMPORAL_TLS_SERVER_NAME=temporal.example.com
```

### Worker Configuration

Edit `server/workflows/worker.ts` to adjust:

```typescript
const worker = await Worker.create({
  connection,
  namespace: 'default',
  taskQueue: 'payment-processing',
  workflowsPath: require.resolve('./payment-workflow'),
  activities,
  maxConcurrentActivityTaskExecutions: 10,  // Adjust based on load
  maxConcurrentWorkflowTaskExecutions: 100, // Adjust based on load
});
```

## Scaling

### Horizontal Scaling

Run multiple worker instances to increase throughput:

**PM2 (adjust instances in ecosystem.config.js):**

```javascript
{
  name: 'vpp-temporal-worker',
  instances: 4, // Increase number of instances
  exec_mode: 'cluster',
}
```

Then restart:

```bash
pnpm run pm2:restart
```

**Systemd (create multiple service files):**

```bash
# Create vpp-temporal-worker@.service template
sudo systemctl start vpp-temporal-worker@1
sudo systemctl start vpp-temporal-worker@2
sudo systemctl start vpp-temporal-worker@3
```

**Docker (use docker-compose):**

```yaml
services:
  vpp-worker:
    image: vpp-temporal-worker
    deploy:
      replicas: 4
    environment:
      - TEMPORAL_ADDRESS=temporal:7233
      - TEMPORAL_NAMESPACE=default
```

### Vertical Scaling

Adjust worker concurrency settings:

```typescript
// Increase for more powerful machines
maxConcurrentActivityTaskExecutions: 20,
maxConcurrentWorkflowTaskExecutions: 200,
```

## Monitoring

### Worker Health

Check worker status:

```bash
# PM2
pm2 status vpp-temporal-worker

# Systemd
sudo systemctl status vpp-temporal-worker

# Docker
docker ps | grep vpp-worker
```

### Worker Logs

View worker logs:

```bash
# PM2
pm2 logs vpp-temporal-worker --lines 100

# Systemd
sudo journalctl -u vpp-temporal-worker -n 100 -f

# Docker
docker logs -f vpp-worker
```

### Temporal UI

Access Temporal Web UI to monitor workflows:

**URL:** http://localhost:8233

Features:
- View workflow executions
- Monitor task queues
- Check worker status
- View workflow history
- Debug failed workflows

### Metrics

Worker metrics are available in Temporal UI:
- Task queue backlog
- Worker utilization
- Activity execution times
- Workflow success/failure rates

## Troubleshooting

### Worker Not Connecting

**Check Temporal server:**

```bash
# Test connection
curl http://localhost:8233

# Check Temporal logs
docker logs nextgen_temporal
```

**Check worker logs:**

```bash
pm2 logs vpp-temporal-worker
```

**Verify configuration:**

```bash
echo $TEMPORAL_ADDRESS
echo $TEMPORAL_NAMESPACE
```

### Workflows Not Executing

**Check task queue:**

In Temporal UI, navigate to Task Queues → `payment-processing`

**Verify worker is polling:**

Worker logs should show:

```
[Temporal Worker] Connected to Temporal server
[Temporal Worker] Worker created for task queue: payment-processing
```

**Check workflow definition:**

Ensure workflow is registered correctly in `server/workflows/payment-workflow.ts`

### High Memory Usage

**Reduce concurrency:**

```typescript
maxConcurrentActivityTaskExecutions: 5,
maxConcurrentWorkflowTaskExecutions: 50,
```

**Enable PM2 memory limit:**

```javascript
{
  max_memory_restart: '512M', // Restart if exceeds 512MB
}
```

### Worker Crashes

**Check logs for errors:**

```bash
pm2 logs vpp-temporal-worker --err
```

**Common issues:**
- Database connection failures
- Payment gateway timeouts
- Network issues
- Memory leaks

**Enable auto-restart:**

PM2 automatically restarts crashed workers. Configure restart policy:

```javascript
{
  autorestart: true,
  max_restarts: 10,
  min_uptime: '10s',
  restart_delay: 5000,
}
```

## Maintenance

### Update Worker Code

**PM2:**

```bash
# Pull latest code
git pull

# Install dependencies
pnpm install

# Restart workers
pnpm run pm2:restart
```

**Systemd:**

```bash
# Pull latest code
git pull

# Install dependencies
pnpm install

# Restart service
sudo systemctl restart vpp-temporal-worker
```

### Graceful Shutdown

Workers handle SIGTERM and SIGINT for graceful shutdown:

```bash
# PM2
pm2 stop vpp-temporal-worker

# Systemd
sudo systemctl stop vpp-temporal-worker

# Docker
docker stop vpp-worker
```

This allows:
- Current activities to complete
- Workflows to be saved
- Clean disconnection from Temporal server

### Backup and Recovery

**Worker state is maintained by Temporal server**, so workers are stateless.

To recover from failures:
1. Restart worker process
2. Worker reconnects to Temporal server
3. Workflows resume automatically

No data loss occurs when workers restart.

## Performance Tuning

### Optimal Configuration

For typical workloads:

```typescript
// 2-4 worker instances
instances: 2-4

// Moderate concurrency
maxConcurrentActivityTaskExecutions: 10
maxConcurrentWorkflowTaskExecutions: 100

// Memory limit
max_memory_restart: '512M'
```

For high-volume workloads:

```typescript
// 4-8 worker instances
instances: 4-8

// High concurrency
maxConcurrentActivityTaskExecutions: 20
maxConcurrentWorkflowTaskExecutions: 200

// Higher memory limit
max_memory_restart: '1G'
```

### Load Testing

Test worker performance:

```bash
# Generate test workflows
for i in {1..100}; do
  curl -X POST http://localhost:3000/api/trpc/paymentProcessing.initiatePayment \
    -H "Content-Type: application/json" \
    -d '{"invoiceId": 1, "gateway": "mpesa", "phoneNumber": "255712345678"}'
done
```

Monitor:
- Task queue backlog in Temporal UI
- Worker CPU/memory usage with `pm2 monit`
- Workflow execution times

## Security

### Production Checklist

- [ ] Enable TLS for Temporal connection
- [ ] Use environment variables for sensitive config
- [ ] Run workers with limited user permissions
- [ ] Enable firewall rules for Temporal port
- [ ] Rotate credentials regularly
- [ ] Monitor worker logs for security events
- [ ] Use secrets management (AWS Secrets Manager, Vault)

### Network Security

```bash
# Allow only specific IPs to access Temporal
sudo ufw allow from 10.0.0.0/8 to any port 7233
```

## Support

For issues or questions:
- **Temporal UI**: http://localhost:8233
- **Worker Logs**: `pm2 logs vpp-temporal-worker`
- **Temporal Documentation**: https://docs.temporal.io
- **Deployment Guide**: `docs/MIDDLEWARE_DEPLOYMENT_GUIDE.md`
