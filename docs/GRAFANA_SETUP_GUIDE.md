# Grafana Monitoring Setup Guide

This guide explains how to set up Grafana dashboards for monitoring the VPP Platform middleware integrations.

## Overview

The VPP Platform includes three pre-configured Grafana dashboards:

1. **Kafka Events Dashboard** - Monitor message publishing, throughput, and error rates
2. **Redis Cache Dashboard** - Track cache performance, hit rates, and memory usage
3. **Temporal Workflows Dashboard** - Observe workflow execution, worker health, and task queues

## Prerequisites

- Prometheus server running and scraping metrics
- Grafana server installed and running
- VPP Platform middleware components configured to expose Prometheus metrics

## Quick Start

### 1. Install Grafana

**Using Docker:**
```bash
docker run -d \
  --name=grafana \
  -p 3001:3000 \
  -v grafana-storage:/var/lib/grafana \
  grafana/grafana-oss:latest
```

**Using Package Manager (Ubuntu/Debian):**
```bash
sudo apt-get install -y software-properties-common
sudo add-apt-repository "deb https://packages.grafana.com/oss/deb stable main"
wget -q -O - https://packages.grafana.com/gpg.key | sudo apt-key add -
sudo apt-get update
sudo apt-get install grafana
sudo systemctl start grafana-server
sudo systemctl enable grafana-server
```

### 2. Access Grafana

Open your browser and navigate to:
```
http://localhost:3001
```

Default credentials:
- Username: `admin`
- Password: `admin` (you'll be prompted to change this)

### 3. Add Prometheus Data Source

1. Click **Configuration** (gear icon) → **Data Sources**
2. Click **Add data source**
3. Select **Prometheus**
4. Configure:
   - **Name**: `Prometheus`
   - **URL**: `http://localhost:9090` (or your Prometheus server URL)
   - **Access**: `Server` (default)
5. Click **Save & Test**

### 4. Import Dashboards

#### Method 1: Import from Files

1. Click **Dashboards** (four squares icon) → **Import**
2. Click **Upload JSON file**
3. Select one of the dashboard files:
   - `grafana/dashboards/kafka-events-dashboard.json`
   - `grafana/dashboards/redis-cache-dashboard.json`
   - `grafana/dashboards/temporal-workflows-dashboard.json`
4. Select the **Prometheus** data source
5. Click **Import**

Repeat for all three dashboards.

#### Method 2: Copy-Paste JSON

1. Click **Dashboards** → **Import**
2. Copy the contents of a dashboard JSON file
3. Paste into the **Import via panel json** text area
4. Click **Load**
5. Select the **Prometheus** data source
6. Click **Import**

## Dashboard Details

### Kafka Events Dashboard

**Metrics Tracked:**
- Message publish rate (messages/sec)
- Total messages published
- Failed messages count
- Success rate percentage
- Publish latency (P95, P99)
- Message distribution by topic
- Error rate by topic

**Key Panels:**
- **Message Publish Rate**: Real-time graph of message throughput
- **Success Rate**: Gauge showing percentage of successful publishes
- **Publish Latency**: P95 and P99 latency trends
- **Messages by Topic**: Pie chart showing distribution across topics

**Alerts to Configure:**
- Success rate < 95%
- P99 latency > 1 second
- Error rate > 10 errors/minute

### Redis Cache Dashboard

**Metrics Tracked:**
- Cache hit rate percentage
- Total keys in cache
- Memory usage
- Connected clients
- Commands per second
- Cache operations (hits/misses)
- Response time (P95, P99)
- Evicted keys rate

**Key Panels:**
- **Cache Hit Rate**: Gauge showing cache effectiveness
- **Memory Usage**: Current memory consumption with thresholds
- **Cache Operations**: Graph comparing hits vs misses
- **Response Time**: P95 and P99 latency trends

**Alerts to Configure:**
- Hit rate < 70%
- Memory usage > 1GB
- P99 latency > 10ms
- Eviction rate > 100/sec

### Temporal Workflows Dashboard

**Metrics Tracked:**
- Workflow execution rate
- Total workflows executed
- Failed workflows count
- Workflow success rate
- Execution duration (P95, P99)
- Active workers count
- Task queue backlog
- Activity execution rate
- Worker CPU and memory usage
- Activity retry rate

**Key Panels:**
- **Workflow Execution Rate**: Real-time workflow throughput
- **Workflow Success Rate**: Gauge showing completion percentage
- **Execution Duration**: P95 and P99 duration trends
- **Active Workers**: Current worker count
- **Task Queue Backlog**: Number of pending tasks

**Alerts to Configure:**
- Success rate < 95%
- Active workers < 1
- Task queue backlog > 100
- P99 duration > 30 seconds
- Worker CPU > 80%

## Prometheus Configuration

Ensure your `prometheus.yml` includes scrape configs for all services:

```yaml
scrape_configs:
  # VPP Web Server
  - job_name: 'vpp-web'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
    
  # Temporal Worker
  - job_name: 'temporal-worker'
    static_configs:
      - targets: ['localhost:9091']
    
  # Redis Exporter
  - job_name: 'redis'
    static_configs:
      - targets: ['localhost:9121']
    
  # Kafka Exporter
  - job_name: 'kafka'
    static_configs:
      - targets: ['localhost:9308']
```

## Metric Exporters

### Redis Exporter

Install and run Redis exporter:

```bash
docker run -d \
  --name redis_exporter \
  -p 9121:9121 \
  oliver006/redis_exporter:latest \
  --redis.addr=redis://localhost:6379
```

### Kafka Exporter

Install and run Kafka exporter:

```bash
docker run -d \
  --name kafka_exporter \
  -p 9308:9308 \
  danielqsj/kafka-exporter:latest \
  --kafka.server=localhost:9092
```

## Dashboard Customization

### Adjust Refresh Rate

1. Click the **Refresh** dropdown (top right)
2. Select desired interval (5s, 10s, 30s, 1m, etc.)
3. Or set auto-refresh: `5s`, `10s`, `30s`, `1m`, `5m`

### Modify Time Range

1. Click the **Time range** picker (top right)
2. Select preset range or custom range
3. Common ranges: Last 15 minutes, Last 1 hour, Last 6 hours, Last 24 hours

### Add Custom Panels

1. Click **Add panel** (top right)
2. Select **Add a new panel**
3. Choose visualization type (Graph, Stat, Gauge, etc.)
4. Add Prometheus query
5. Configure display options
6. Click **Apply**

### Set Up Alerts

1. Edit a panel
2. Click **Alert** tab
3. Click **Create alert rule from this panel**
4. Configure:
   - **Rule name**: Descriptive name
   - **Condition**: Threshold and evaluation
   - **Notifications**: Contact point
5. Click **Save**

## Alert Configuration Examples

### Kafka High Error Rate

```yaml
Alert: Kafka High Error Rate
Condition: rate(kafka_messages_published_total{status="error"}[5m]) > 10
For: 5m
Severity: warning
Message: Kafka error rate is above 10 errors/minute
```

### Redis Low Hit Rate

```yaml
Alert: Redis Low Hit Rate
Condition: (redis_keyspace_hits_total / (redis_keyspace_hits_total + redis_keyspace_misses_total)) * 100 < 70
For: 10m
Severity: warning
Message: Redis cache hit rate is below 70%
```

### Temporal Worker Down

```yaml
Alert: Temporal Worker Down
Condition: temporal_worker_active_count < 1
For: 1m
Severity: critical
Message: No active Temporal workers detected
```

### Temporal High Failure Rate

```yaml
Alert: Temporal High Failure Rate
Condition: sum(rate(temporal_workflow_execution_total{status="failed"}[5m])) / sum(rate(temporal_workflow_execution_total[5m])) * 100 > 5
For: 5m
Severity: warning
Message: Workflow failure rate is above 5%
```

## Notification Channels

### Slack Integration

1. Go to **Alerting** → **Contact points**
2. Click **New contact point**
3. Select **Slack**
4. Configure:
   - **Name**: `Slack Alerts`
   - **Webhook URL**: Your Slack webhook URL
   - **Channel**: `#vpp-alerts`
5. Click **Save**

### Email Integration

1. Go to **Alerting** → **Contact points**
2. Click **New contact point**
3. Select **Email**
4. Configure:
   - **Name**: `Email Alerts`
   - **Addresses**: Comma-separated email addresses
5. Click **Save**

### PagerDuty Integration

1. Go to **Alerting** → **Contact points**
2. Click **New contact point**
3. Select **PagerDuty**
4. Configure:
   - **Name**: `PagerDuty Alerts`
   - **Integration Key**: Your PagerDuty integration key
5. Click **Save**

## Best Practices

### Dashboard Organization

1. **Create folders** for different environments (Development, Staging, Production)
2. **Use consistent naming** for dashboards and panels
3. **Add descriptions** to panels explaining what they show
4. **Set appropriate refresh rates** (5s for real-time, 1m for historical)

### Performance Optimization

1. **Limit time ranges** for queries (avoid "All time")
2. **Use recording rules** in Prometheus for expensive queries
3. **Reduce scrape intervals** for less critical metrics
4. **Use dashboard variables** for dynamic filtering

### Security

1. **Change default admin password** immediately
2. **Enable authentication** (LDAP, OAuth, etc.)
3. **Set up role-based access control** (RBAC)
4. **Use HTTPS** for Grafana access
5. **Restrict data source access** by user role

## Troubleshooting

### No Data in Dashboards

**Check Prometheus is scraping:**
```bash
curl http://localhost:9090/api/v1/targets
```

**Verify metrics are exposed:**
```bash
curl http://localhost:3000/metrics
```

**Check Grafana data source:**
1. Go to **Configuration** → **Data Sources**
2. Click on **Prometheus**
3. Click **Save & Test**

### Dashboards Not Loading

**Check Grafana logs:**
```bash
# Docker
docker logs grafana

# Systemd
sudo journalctl -u grafana-server -f
```

**Verify dashboard JSON is valid:**
```bash
cat grafana/dashboards/kafka-events-dashboard.json | jq .
```

### Metrics Not Appearing

**Verify Prometheus configuration:**
```bash
curl http://localhost:9090/api/v1/label/__name__/values | grep -i kafka
```

**Check metric names in dashboard queries:**
- Ensure metric names match what Prometheus is scraping
- Check for typos in metric names
- Verify label selectors are correct

## Production Checklist

- [ ] Grafana installed and running
- [ ] Prometheus data source configured
- [ ] All three dashboards imported
- [ ] Metric exporters running (Redis, Kafka)
- [ ] Alerts configured for critical metrics
- [ ] Notification channels set up (Slack, Email, PagerDuty)
- [ ] HTTPS enabled for Grafana
- [ ] Authentication configured
- [ ] Role-based access control set up
- [ ] Backup strategy for dashboards
- [ ] Monitoring retention policy defined

## Additional Resources

- [Grafana Documentation](https://grafana.com/docs/)
- [Prometheus Query Language](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Grafana Alerting](https://grafana.com/docs/grafana/latest/alerting/)
- [Dashboard Best Practices](https://grafana.com/docs/grafana/latest/best-practices/)

## Next Steps

1. **Customize thresholds** in gauges and alerts based on your SLAs
2. **Add more panels** for application-specific metrics
3. **Create composite dashboards** combining multiple data sources
4. **Set up automated reports** for stakeholders
5. **Implement log aggregation** (Loki) for correlation with metrics

For questions or issues, refer to the main deployment guide: `docs/MIDDLEWARE_DEPLOYMENT_GUIDE.md`
