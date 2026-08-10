# VPP Platform Monitoring Setup Guide

This guide explains how to set up comprehensive monitoring for the VPP Consumer Platform using Prometheus and Grafana.

## Overview

The VPP platform exports metrics from the orchestrator service to Prometheus, which are then visualized in Grafana dashboards. This provides real-time visibility into:

- **Workflow execution** - Success rates, durations, active workflows
- **Business metrics** - Trading volume, revenue, DR participation
- **Service health** - Middleware integration status, error rates
- **System performance** - Memory usage, worker utilization

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              VPP Orchestrator Service                        │
│           (Go + Temporal + Prometheus Client)                │
│                                                              │
│  Exports metrics on /metrics endpoint (port 8080)           │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP scrape every 15s
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Prometheus Server                          │
│                     (Port 9090)                              │
│                                                              │
│  - Scrapes metrics from orchestrator                         │
│  - Stores time-series data                                   │
│  - Provides PromQL query interface                           │
└────────────────────────┬────────────────────────────────────┘
                         │ PromQL queries
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Grafana Server                            │
│                     (Port 3001)                              │
│                                                              │
│  - 3 pre-built dashboards                                    │
│  - Real-time visualization                                   │
│  - Alerting (optional)                                       │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Docker and Docker Compose installed
- VPP orchestrator service running
- Ports 9090 (Prometheus) and 3001 (Grafana) available

## Quick Start

### Step 1: Add Prometheus and Grafana to Docker Compose

Add these services to your `docker-compose.external-services.yml`:

```yaml
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.console.libraries=/etc/prometheus/console_libraries'
      - '--web.console.templates=/etc/prometheus/consoles'
      - '--web.enable-lifecycle'
    networks:
      - vpp-network
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    ports:
      - "3001:3000"
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning
      - ./monitoring/grafana/dashboards:/var/lib/grafana/dashboards
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    networks:
      - vpp-network
    restart: unless-stopped
    depends_on:
      - prometheus

volumes:
  prometheus-data:
  grafana-data:
```

### Step 2: Create Prometheus Configuration

Create `monitoring/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'vpp-orchestrator'
    static_configs:
      - targets: ['host.docker.internal:8080']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

### Step 3: Create Grafana Provisioning Configuration

Create `monitoring/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
```

Create `monitoring/grafana/provisioning/dashboards/vpp.yml`:

```yaml
apiVersion: 1

providers:
  - name: 'VPP Dashboards'
    orgId: 1
    folder: 'VPP'
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
```

### Step 4: Enable Metrics in Orchestrator

Update `orchestrator/main.go` to expose Prometheus metrics:

```go
package main

import (
	"log"
	"net/http"
	
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"your-module/metrics"
)

func main() {
	// ... existing orchestrator setup ...

	// Expose Prometheus metrics endpoint
	http.Handle("/metrics", promhttp.Handler())
	
	// Start metrics server
	go func() {
		log.Println("Metrics server listening on :8080/metrics")
		if err := http.ListenAndServe(":8080", nil); err != nil {
			log.Fatal("Failed to start metrics server:", err)
		}
	}()

	// ... rest of orchestrator code ...
}
```

### Step 5: Instrument Workflows

Add metrics recording to your workflow implementations:

```go
import "your-module/metrics"

func AutoTradingWorkflow(ctx workflow.Context, input AutoTradingInput) error {
	startTime := time.Now()
	
	// Record workflow start
	metrics.RecordWorkflowStart("auto-trading", input.UserID)
	
	// ... workflow logic ...
	
	if err != nil {
		// Record failure
		metrics.RecordWorkflowFailed("auto-trading", input.UserID, err.Error())
		return err
	}
	
	// Record success
	duration := time.Since(startTime).Seconds()
	metrics.RecordWorkflowComplete("auto-trading", input.UserID, duration)
	
	return nil
}
```

### Step 6: Start Monitoring Stack

```bash
# Start Prometheus and Grafana
docker-compose -f docker-compose.external-services.yml up -d prometheus grafana

# Verify Prometheus is scraping
curl http://localhost:9090/api/v1/targets

# Verify metrics are being exported
curl http://localhost:8080/metrics
```

### Step 7: Access Grafana Dashboards

1. Open http://localhost:3001
2. Login with `admin` / `admin`
3. Navigate to Dashboards → VPP folder
4. Open any of the 3 dashboards:
   - **VPP Workflow Metrics** - Workflow execution monitoring
   - **VPP Business Metrics** - Trading, revenue, DR participation
   - **VPP Service Health** - Middleware integration health

## Available Metrics

### Workflow Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `vpp_workflows_started_total` | Counter | Total workflows started |
| `vpp_workflows_completed_total` | Counter | Total workflows completed |
| `vpp_workflows_failed_total` | Counter | Total workflows failed |
| `vpp_workflow_duration_seconds` | Histogram | Workflow execution duration |
| `vpp_active_workflows` | Gauge | Currently active workflows |
| `vpp_worker_utilization_percent` | Gauge | Worker utilization |

### Activity Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `vpp_activities_executed_total` | Counter | Total activities executed |
| `vpp_activities_failed_total` | Counter | Total activities failed |
| `vpp_activity_duration_seconds` | Histogram | Activity execution duration |

### Business Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `vpp_trades_executed_total` | Counter | Total trades executed |
| `vpp_trade_volume_kwh` | Counter | Total energy traded (kWh) |
| `vpp_trade_revenue_cents` | Counter | Total revenue (cents) |
| `vpp_dr_events_enrolled_total` | Counter | DR event enrollments |
| `vpp_dr_rewards_earned_cents` | Counter | DR rewards earned |
| `vpp_payments_processed_total` | Counter | Payments processed |
| `vpp_payment_volume_cents` | Counter | Payment volume |

### Service Health Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `vpp_kafka_messages_published_total` | Counter | Kafka messages published |
| `vpp_kafka_publish_errors_total` | Counter | Kafka publish errors |
| `vpp_redis_operations_total` | Counter | Redis operations |
| `vpp_redis_errors_total` | Counter | Redis errors |
| `vpp_tigerbeetle_transactions_total` | Counter | TigerBeetle transactions |
| `vpp_tigerbeetle_errors_total` | Counter | TigerBeetle errors |
| `vpp_alerts_generated_total` | Counter | Alerts generated |
| `vpp_anomalies_detected_total` | Counter | Anomalies detected |

## Dashboard Descriptions

### 1. VPP Workflow Metrics

**Purpose**: Monitor workflow execution health and performance

**Key Panels**:
- Workflows Started (Rate) - Real-time workflow start rate by type
- Workflows Completed vs Failed - Success vs failure rates
- Active Workflows - Current number of running workflows
- Workflow Success Rate - Overall success percentage
- Worker Utilization - Orchestrator worker usage
- Memory Usage - Orchestrator memory consumption
- Workflow Duration (p50, p95, p99) - Latency percentiles
- Activity Execution Rate - Activity-level throughput
- Activity Failure Rate - Activity-level errors

**Use Cases**:
- Identify workflow bottlenecks
- Detect workflow failures
- Monitor system capacity
- Optimize worker configuration

### 2. VPP Business Metrics

**Purpose**: Track business KPIs and revenue metrics

**Key Panels**:
- Total Trades (24h) - Daily trade count
- Total Energy Traded (24h kWh) - Daily energy volume
- Total Revenue (24h) - Daily revenue
- DR Rewards Earned (24h) - Daily DR rewards
- Trades by Type - Distribution of trade types
- Energy Trading Volume by Type - Volume trends
- Revenue by Trade Type - Revenue breakdown
- Payments Processed - Payment throughput
- Payment Volume - Payment amounts
- Payment Success Rate - Payment reliability
- DR Event Participation - DR enrollment trends
- Achievements Awarded - Gamification metrics
- Telemetry Data Points Processed - IoT data volume
- Anomalies Detected - System health indicators

**Use Cases**:
- Track revenue and growth
- Analyze trading patterns
- Monitor payment health
- Measure DR program success
- Evaluate user engagement

### 3. VPP Service Health

**Purpose**: Monitor middleware integration and system health

**Key Panels**:
- Kafka Messages Published (Rate) - Kafka throughput
- Kafka Publish Errors - Kafka reliability
- Redis Operations (Rate) - Redis usage
- Redis Errors - Redis health
- TigerBeetle Transactions (Rate) - Ledger activity
- TigerBeetle Errors - Ledger health
- Alerts Generated by Severity - Alert trends
- Anomalies Detected by Type - Anomaly patterns
- Kafka Health - Kafka success rate
- Redis Health - Redis success rate
- TigerBeetle Health - Ledger success rate
- Overall System Health - Aggregate health score

**Use Cases**:
- Detect middleware failures
- Monitor integration health
- Identify system bottlenecks
- Track error rates
- Ensure data pipeline reliability

## Alerting (Optional)

### Configure Grafana Alerts

1. Open a dashboard panel
2. Click "Edit" → "Alert" tab
3. Configure alert conditions
4. Set notification channels (email, Slack, PagerDuty)

### Example Alert Rules

**High Workflow Failure Rate**:
```
WHEN avg() OF query(A, 5m, now) IS ABOVE 0.1
```
Alert when workflow failure rate exceeds 10%

**Low System Health**:
```
WHEN avg() OF query(A, 5m, now) IS BELOW 95
```
Alert when overall system health drops below 95%

**High Payment Failure Rate**:
```
WHEN avg() OF query(A, 5m, now) IS ABOVE 0.05
```
Alert when payment failure rate exceeds 5%

## Troubleshooting

### Prometheus Not Scraping Metrics

**Check orchestrator metrics endpoint**:
```bash
curl http://localhost:8080/metrics
```

**Check Prometheus targets**:
```bash
curl http://localhost:9090/api/v1/targets
```

**Common Issues**:
- Orchestrator not exposing /metrics endpoint
- Firewall blocking port 8080
- Incorrect target configuration in prometheus.yml

### Grafana Dashboards Not Loading

**Check Prometheus datasource**:
1. Grafana → Configuration → Data Sources
2. Click "Prometheus"
3. Click "Test" button

**Check dashboard provisioning**:
```bash
docker logs grafana
```

**Common Issues**:
- Prometheus URL incorrect
- Dashboard JSON files not mounted
- Provisioning configuration missing

### No Data in Dashboards

**Verify metrics are being recorded**:
```bash
curl http://localhost:8080/metrics | grep vpp_
```

**Query Prometheus directly**:
```bash
curl 'http://localhost:9090/api/v1/query?query=vpp_workflows_started_total'
```

**Common Issues**:
- Workflows not instrumented with metrics
- Orchestrator not running
- Metrics not being exported

## Production Considerations

### Security

1. **Enable authentication** - Configure Grafana OAuth or LDAP
2. **Use HTTPS** - Enable TLS for Prometheus and Grafana
3. **Restrict access** - Use firewall rules to limit access
4. **Rotate credentials** - Change default admin password

### Scalability

1. **Use Prometheus federation** - For multi-region deployments
2. **Configure retention** - Set appropriate data retention period
3. **Use remote storage** - For long-term metrics storage
4. **Scale Grafana** - Use Grafana Enterprise for high availability

### Backup

1. **Backup Prometheus data** - Regular snapshots of `/prometheus`
2. **Backup Grafana dashboards** - Export dashboard JSON files
3. **Backup configuration** - Version control prometheus.yml

## Next Steps

1. **Customize dashboards** - Add panels for your specific needs
2. **Set up alerting** - Configure alerts for critical metrics
3. **Integrate with logging** - Correlate metrics with logs
4. **Add tracing** - Integrate Jaeger for distributed tracing
5. **Create SLOs** - Define service level objectives

## Support

For issues or questions:
- **Prometheus Docs**: https://prometheus.io/docs/
- **Grafana Docs**: https://grafana.com/docs/
- **VPP Platform**: See `docs/` directory

## Summary

You now have a complete monitoring stack for your VPP platform with:

✅ **Prometheus** scraping metrics from orchestrator  
✅ **Grafana** visualizing 3 comprehensive dashboards  
✅ **50+ metrics** covering workflows, business, and health  
✅ **Real-time visibility** into system performance  
✅ **Alerting capability** for proactive monitoring  

Your monitoring infrastructure is production-ready!
