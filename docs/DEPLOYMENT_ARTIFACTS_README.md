# VPP Platform - Deployment Artifacts

This document provides an overview of all deployment artifacts, testing tools, monitoring dashboards, and security configurations included in the VPP Platform v21.0 release.

## Overview

The VPP Platform includes production-ready deployment artifacts organized into three main categories:

1. **Automated Testing Suite** - Scripts to validate all middleware integrations
2. **Monitoring Dashboards** - Grafana dashboards for observability
3. **Security Configuration** - Comprehensive security hardening guides

## Directory Structure

```
vpp_consumer_platform/
├── scripts/                          # Automated test scripts
│   ├── test-temporal-worker.sh       # Temporal worker deployment tests
│   ├── test-keycloak.sh              # Keycloak authentication tests
│   ├── test-lakehouse-etl.sh         # Lakehouse ETL pipeline tests
│   └── run-all-tests.sh              # Master test runner
├── grafana/                          # Monitoring dashboards
│   └── dashboards/
│       ├── kafka-events-dashboard.json
│       ├── redis-cache-dashboard.json
│       └── temporal-workflows-dashboard.json
└── docs/                             # Documentation
    ├── DEPLOYMENT_TESTING_GUIDE.md   # Manual testing procedures
    ├── GRAFANA_SETUP_GUIDE.md        # Dashboard setup instructions
    ├── PRODUCTION_SECURITY_GUIDE.md  # Security hardening guide
    ├── TEMPORAL_WORKER_DEPLOYMENT.md # Worker deployment guide
    ├── KEYCLOAK_SETUP_GUIDE.md       # SSO configuration guide
    ├── LAKEHOUSE_ETL_DEPLOYMENT.md   # ETL pipeline deployment
    └── MIDDLEWARE_DEPLOYMENT_GUIDE.md # Overall deployment guide
```

## 1. Automated Testing Suite

### Test Scripts

#### `scripts/test-temporal-worker.sh`
Tests Temporal worker deployment and configuration.

**Tests Performed (10 tests):**
- PM2 installation verification
- Ecosystem configuration file check
- Worker script existence
- Temporal server connectivity
- Temporal Web UI accessibility
- Worker process status
- Worker logs verification
- Package.json scripts check
- Temporal SDK dependencies
- Worker configuration validation

**Usage:**
```bash
cd /home/ubuntu/vpp_consumer_platform
./scripts/test-temporal-worker.sh
```

**Expected Output:**
- All tests pass: Exit code 0
- Some tests fail: Exit code 1 with detailed error messages

#### `scripts/test-keycloak.sh`
Tests Keycloak authentication integration.

**Tests Performed (10 tests):**
- Keycloak server connectivity
- Realm endpoint accessibility
- OpenID Connect configuration
- Keycloak client implementation
- Environment variables check
- Token endpoint verification
- User authentication (if credentials provided)
- Token validation
- User info endpoint
- Setup guide documentation

**Usage:**
```bash
# Basic test
./scripts/test-keycloak.sh

# With authentication test
TEST_USERNAME=testuser TEST_PASSWORD=testpass ./scripts/test-keycloak.sh
```

**Environment Variables:**
- `KEYCLOAK_SERVER_URL` - Keycloak server URL (default: http://localhost:8080)
- `KEYCLOAK_REALM` - Realm name (default: vpp-platform)
- `KEYCLOAK_CLIENT_ID` - Client ID (default: vpp-consumer-platform)
- `KEYCLOAK_CLIENT_SECRET` - Client secret (required for auth tests)
- `TEST_USERNAME` - Test user username (optional)
- `TEST_PASSWORD` - Test user password (optional)

#### `scripts/test-lakehouse-etl.sh`
Runs the `services/lakehouse` ingestion test suite (`pytest`).

**Tests Performed:**
- Parquet encoding, including the refusal to encode an empty batch
- Object-store writes with read-back digest verification, and detection of a
  truncated or corrupted read-back
- Configuration refusals (no implicit local or unnamed store)
- With `LAKEHOUSE_TEST_DSN`: the pipeline against real PostgreSQL — watermark
  advancement, empty second runs, failure recording, advisory locking, tie-breaking
  on equal timestamps and backlog counting

**Usage:**
```bash
./scripts/test-lakehouse-etl.sh
```

**Environment Variables:**
- `LAKEHOUSE_TEST_DSN` - PostgreSQL DSN for the pipeline tests. Unset, those tests
  are skipped and the script says so; it does not report them as passed.
- `PYTHON` - interpreter to use (default: `python3`)

#### `scripts/run-all-tests.sh`
Master test runner that executes all test suites.

**Usage:**
```bash
./scripts/run-all-tests.sh
```

**Output:**
- Runs all three test suites sequentially
- Provides overall summary with success rate
- Exit code 0 if all suites pass, 1 if any fail

### Test Results Interpretation

**Success Indicators:**
- ✓ PASS - Test passed successfully
- Green text - All tests in suite passed

**Failure Indicators:**
- ✗ FAIL - Test failed with error message
- Red text - One or more tests failed

**Skip Indicators:**
- ⊘ SKIP - Test skipped (dependency not met)
- Yellow text - Warning or informational message

## 2. Monitoring Dashboards

### Grafana Dashboards

All dashboards are provided as JSON files compatible with Grafana 8.0+.

#### Kafka Events Dashboard
**File:** `grafana/dashboards/kafka-events-dashboard.json`

**Panels (7 panels):**
1. **Message Publish Rate** - Real-time message throughput graph
2. **Total Messages Published** - Cumulative success count
3. **Failed Messages** - Total error count with red threshold
4. **Success Rate** - Gauge showing publish success percentage
5. **Publish Latency (P95)** - P95 and P99 latency trends
6. **Messages by Topic** - Pie chart of message distribution
7. **Error Rate by Topic** - Error rate trends per topic

**Metrics Required:**
- `kafka_messages_published_total{status="success|error"}`
- `kafka_publish_duration_seconds_bucket`

**Recommended Alerts:**
- Success rate < 95%
- P99 latency > 1 second
- Error rate > 10 errors/minute

#### Redis Cache Dashboard
**File:** `grafana/dashboards/redis-cache-dashboard.json`

**Panels (9 panels):**
1. **Cache Hit Rate** - Gauge showing hit rate percentage
2. **Total Keys** - Current key count with thresholds
3. **Memory Usage** - Current memory consumption
4. **Connected Clients** - Active client connections
5. **Commands per Second** - Command throughput
6. **Cache Operations** - Hits vs misses graph
7. **Response Time (P95, P99)** - Latency trends
8. **Memory Usage Over Time** - Memory consumption trends
9. **Evicted Keys** - Key eviction rate

**Metrics Required:**
- `redis_keyspace_hits_total`
- `redis_keyspace_misses_total`
- `redis_db_keys`
- `redis_memory_used_bytes`
- `redis_connected_clients`
- `redis_commands_processed_total`
- `redis_command_duration_seconds_bucket`
- `redis_evicted_keys_total`

**Recommended Alerts:**
- Hit rate < 70%
- Memory usage > 1GB
- P99 latency > 10ms
- Eviction rate > 100/sec

#### Temporal Workflows Dashboard
**File:** `grafana/dashboards/temporal-workflows-dashboard.json`

**Panels (12 panels):**
1. **Workflow Execution Rate** - Real-time workflow throughput
2. **Total Workflows Executed** - Cumulative execution count
3. **Failed Workflows** - Total failure count
4. **Workflow Success Rate** - Success percentage gauge
5. **Workflow Execution Duration (P95)** - P95 and P99 duration
6. **Active Workers** - Current worker count
7. **Task Queue Backlog** - Pending task count
8. **Activity Execution Rate** - Activity throughput
9. **Workflow Status Distribution** - Pie chart of statuses
10. **Worker CPU Usage** - CPU utilization per worker
11. **Worker Memory Usage** - Memory consumption per worker
12. **Activity Retry Rate** - Retry rate per activity

**Metrics Required:**
- `temporal_workflow_execution_total{status="completed|failed"}`
- `temporal_workflow_duration_seconds_bucket`
- `temporal_worker_active_count`
- `temporal_task_queue_backlog{queue="payment-processing"}`
- `temporal_activity_execution_total`
- `temporal_activity_retry_total`
- `process_cpu_seconds_total{job="temporal-worker"}`
- `process_resident_memory_bytes{job="temporal-worker"}`

**Recommended Alerts:**
- Success rate < 95%
- Active workers < 1
- Task queue backlog > 100
- P99 duration > 30 seconds
- Worker CPU > 80%

### Dashboard Import Instructions

1. Install Grafana (see GRAFANA_SETUP_GUIDE.md)
2. Add Prometheus data source
3. Import dashboard JSON files
4. Configure alerts and notification channels

## 3. Security Configuration

### Security Guides

#### Production Security Guide
**File:** `docs/PRODUCTION_SECURITY_GUIDE.md`

**Sections:**
1. **TLS/SSL Configuration** - Certificate generation and service configuration
2. **Keycloak Security** - Password policies, MFA, brute force protection
3. **Secrets Management** - AWS Secrets Manager, HashiCorp Vault, encrypted env vars
4. **Network Security** - Firewall rules, service isolation, IP whitelisting
5. **Audit Logging** - Event logging, centralized logging with ELK
6. **Rate Limiting** - Nginx and application-level rate limiting
7. **CORS Configuration** - Cross-origin resource sharing setup
8. **Database Security** - Connection security, encryption at rest, least privilege
9. **Security Monitoring** - Security alerts, intrusion detection
10. **Compliance** - GDPR, OWASP Top 10, regular security tasks

**Critical Checklist (10 items):**
- [ ] Change all default passwords
- [ ] Enable TLS for all services
- [ ] Configure firewall rules
- [ ] Set up secrets management
- [ ] Enable audit logging
- [ ] Configure brute force protection
- [ ] Set up MFA for admin accounts
- [ ] Review and restrict API access
- [ ] Enable rate limiting
- [ ] Configure CORS properly

## 4. Documentation

### Deployment Guides

#### Temporal Worker Deployment
**File:** `docs/TEMPORAL_WORKER_DEPLOYMENT.md`

**Topics:**
- PM2 configuration and clustering
- Worker process management
- Deployment options (PM2, systemd, Docker, Kubernetes)
- Monitoring and troubleshooting
- Scaling guidelines

#### Keycloak Setup Guide
**File:** `docs/KEYCLOAK_SETUP_GUIDE.md`

**Topics:**
- Realm creation and configuration
- Client setup with authentication flows
- Role management (admin, user, operator)
- Security features (password policies, MFA, brute force detection)
- Advanced features (user federation, social login, custom themes)

#### Lakehouse ETL Deployment
**File:** `docs/LAKEHOUSE_ETL_DEPLOYMENT.md`

**Topics:**
- Python environment setup
- Dependency installation
- Deployment options (systemd, Docker, Kubernetes)
- Event topic mappings (10 topics)
- Query examples (Python, Spark SQL, Trino)
- Maintenance procedures

#### Grafana Setup Guide
**File:** `docs/GRAFANA_SETUP_GUIDE.md`

**Topics:**
- Grafana installation and configuration
- Prometheus data source setup
- Dashboard import procedures
- Alert configuration examples
- Notification channel setup (Slack, Email, PagerDuty)
- Best practices and troubleshooting

#### Deployment Testing Guide
**File:** `docs/DEPLOYMENT_TESTING_GUIDE.md`

**Topics:**
- Manual testing procedures (34 tests)
- Test categories (Temporal, Keycloak, Lakehouse, Integration, Performance, Monitoring, Failure)
- Expected results and verification steps
- Test results template
- Troubleshooting guide

## Quick Start Guide

### 1. Run Automated Tests

```bash
cd /home/ubuntu/vpp_consumer_platform

# Run all tests
./scripts/run-all-tests.sh

# Or run individual test suites
./scripts/test-temporal-worker.sh
./scripts/test-keycloak.sh
./scripts/test-lakehouse-etl.sh
```

### 2. Set Up Monitoring

```bash
# Install Grafana
docker run -d --name=grafana -p 3001:3000 grafana/grafana-oss:latest

# Access Grafana at http://localhost:3001
# Default credentials: admin/admin

# Import dashboards from grafana/dashboards/
```

See `docs/GRAFANA_SETUP_GUIDE.md` for detailed instructions.

### 3. Configure Security

```bash
# Follow the security checklist in docs/PRODUCTION_SECURITY_GUIDE.md

# Key steps:
# 1. Generate SSL certificates
# 2. Configure TLS for all services
# 3. Set up secrets management
# 4. Enable audit logging
# 5. Configure firewall rules
```

## Deployment Workflow

### Development Environment

1. **Run Tests**
   ```bash
   ./scripts/run-all-tests.sh
   ```

2. **Fix Issues**
   - Review test output
   - Follow troubleshooting guides
   - Re-run tests

3. **Set Up Monitoring**
   - Import Grafana dashboards
   - Configure Prometheus scraping
   - Verify metrics are flowing

### Staging Environment

1. **Deploy Middleware**
   - Follow deployment guides for each component
   - Use Docker Compose for easier management

2. **Run Integration Tests**
   - Execute all 34 tests from DEPLOYMENT_TESTING_GUIDE.md
   - Verify end-to-end flows

3. **Configure Security**
   - Apply security hardening from PRODUCTION_SECURITY_GUIDE.md
   - Set up TLS for all services
   - Enable audit logging

### Production Environment

1. **Pre-Deployment Checklist**
   - [ ] All tests passing
   - [ ] Monitoring dashboards configured
   - [ ] Security checklist completed
   - [ ] Secrets management implemented
   - [ ] Backup strategy tested

2. **Deploy Services**
   - Use Kubernetes or Docker Swarm for orchestration
   - Enable auto-scaling for workers
   - Configure load balancing

3. **Post-Deployment Verification**
   - Run automated tests
   - Verify monitoring dashboards
   - Check security logs
   - Perform load testing

## Troubleshooting

### Tests Failing

**Check logs:**
```bash
# Temporal worker logs
pm2 logs vpp-temporal-worker

# Keycloak logs
docker logs keycloak

# Lakehouse ingestion: the job records its own runs, including the exact error
# behind a failure
psql "$DATABASE_URL" -c "SELECT dataset, state, rows_written, object_key, error
                          FROM lakehouse_runs ORDER BY id DESC LIMIT 10;"
kubectl -n lakehouse logs job/lakehouse-ingest-<timestamp>
```

**Common issues:**
- Services not running
- Incorrect environment variables
- Network connectivity issues
- Missing dependencies

### Dashboards Not Showing Data

**Verify Prometheus is scraping:**
```bash
curl http://localhost:9090/api/v1/targets
```

**Check metrics endpoints:**
```bash
curl http://localhost:3000/metrics
curl http://localhost:9091/metrics  # Temporal worker
```

**Verify Grafana data source:**
- Go to Configuration → Data Sources
- Click on Prometheus
- Click "Save & Test"

### Security Issues

**Review audit logs:**
```bash
tail -f logs/audit.log
```

**Check firewall rules:**
```bash
sudo ufw status verbose
```

**Verify TLS certificates:**
```bash
openssl s_client -connect vpp-platform.yourdomain.com:443
```

## Support and Resources

### Documentation
- [Middleware Deployment Guide](MIDDLEWARE_DEPLOYMENT_GUIDE.md)
- [Deployment Testing Guide](DEPLOYMENT_TESTING_GUIDE.md)
- [Grafana Setup Guide](GRAFANA_SETUP_GUIDE.md)
- [Production Security Guide](PRODUCTION_SECURITY_GUIDE.md)

### External Resources
- [Temporal Documentation](https://docs.temporal.io/)
- [Keycloak Documentation](https://www.keycloak.org/documentation)
- [Grafana Documentation](https://grafana.com/docs/)
- [Prometheus Documentation](https://prometheus.io/docs/)

### Getting Help
- Review troubleshooting sections in each guide
- Check logs for error messages
- Consult external documentation
- Contact support team

## Version History

### v21.0 (Current)
- Added automated testing suite (3 test scripts)
- Created Grafana monitoring dashboards (3 dashboards)
- Comprehensive production security guide
- Master test runner script
- Complete documentation suite

### v20.0
- PM2 ecosystem configuration
- Deployment guides for all middleware
- Testing procedures documentation

### v19.0
- Temporal SDK integration
- Keycloak authentication bridge
- Lakehouse ETL pipeline
- Kafka event streaming
- Redis caching layer

## License

Copyright © 2024 VPP Platform. All rights reserved.
