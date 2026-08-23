# VPP Platform - Quick Deployment Guide

**Version:** v22.0  
**Last Updated:** 2024-01-16  

This guide provides quick deployment instructions for all VPP Platform components.

---

## Deployment Overview

The VPP Platform consists of:
1. **Application Layer** - Web server + Temporal worker
2. **Monitoring Stack** - Prometheus + Grafana + Alertmanager
3. **Middleware Services** - Temporal, Keycloak, Kafka, Redis
4. **Security Layer** - TLS, Firewall, Secrets Management

---

## Prerequisites

### System Requirements
- Ubuntu 22.04 LTS or later
- 4 CPU cores minimum (8 recommended)
- 8GB RAM minimum (16GB recommended)
- 50GB disk space minimum (100GB recommended)
- Root access for system-level configuration

### Software Requirements
- Node.js 22.x
- Python 3.11+
- PostgreSQL 14+ database
- Docker (optional, for containerized deployment)

---

## Quick Start (5 Minutes)

### Option 1: With Docker (Recommended)

```bash
cd /home/ubuntu/vpp_consumer_platform

# 1. Deploy monitoring stack
docker-compose -f docker-compose.monitoring.yml up -d

# 2. Start application
pnpm run pm2:start

# 3. Verify deployment
./scripts/run-all-tests.sh
```

### Option 2: Without Docker

```bash
cd /home/ubuntu/vpp_consumer_platform

# 1. Deploy Prometheus
sudo ./scripts/deploy-prometheus.sh

# 2. Start application
pnpm run pm2:start

# 3. Verify deployment
./scripts/run-all-tests.sh
```

---

## Detailed Deployment Steps

### Step 1: Prepare Environment

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install dependencies
sudo apt-get install -y curl wget git build-essential

# Navigate to project
cd /home/ubuntu/vpp_consumer_platform

# Install Node.js dependencies
pnpm install
```

### Step 2: Configure Environment Variables

```bash
# Copy example environment file
cp .env.example .env

# Edit environment variables
nano .env
```

**Required Variables:**
```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/vpp_platform"

# Application
JWT_SECRET="your-secret-key-here"
VITE_APP_TITLE="VPP Platform"

# Temporal
TEMPORAL_ADDRESS="localhost:7233"

# Keycloak
KEYCLOAK_SERVER_URL="http://localhost:8080"
KEYCLOAK_REALM="vpp-platform"
KEYCLOAK_CLIENT_ID="vpp-consumer-platform"
KEYCLOAK_CLIENT_SECRET="your-client-secret"

# Kafka
KAFKA_BOOTSTRAP_SERVERS="localhost:9092"

# Redis
REDIS_URL="redis://localhost:6379"
```

### Step 3: Deploy Database

```bash
# Push database schema
pnpm db:push

# Verify database connection
pnpm db:studio
```

### Step 4: Deploy Monitoring Stack

#### With Docker:

```bash
# Start all monitoring services
docker-compose -f docker-compose.monitoring.yml up -d

# Verify services
docker-compose -f docker-compose.monitoring.yml ps

# View logs
docker-compose -f docker-compose.monitoring.yml logs -f
```

**Services Started:**
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3001 (admin/admin)
- Alertmanager: http://localhost:9093
- Redis Exporter: http://localhost:9121/metrics
- Kafka Exporter: http://localhost:9308/metrics
- Node Exporter: http://localhost:9100/metrics

#### Without Docker:

```bash
# Deploy Prometheus
sudo ./scripts/deploy-prometheus.sh

# Deploy Grafana (manual installation)
sudo apt-get install -y software-properties-common
sudo add-apt-repository "deb https://packages.grafana.com/oss/deb stable main"
wget -q -O - https://packages.grafana.com/gpg.key | sudo apt-key add -
sudo apt-get update
sudo apt-get install -y grafana

# Start Grafana
sudo systemctl enable grafana-server
sudo systemctl start grafana-server

# Access Grafana at http://localhost:3000 (admin/admin)
```

### Step 5: Configure Grafana Dashboards

```bash
# Access Grafana
open http://localhost:3001

# Login with admin/admin (change password on first login)

# Add Prometheus data source:
# 1. Go to Configuration → Data Sources
# 2. Click "Add data source"
# 3. Select "Prometheus"
# 4. URL: http://prometheus:9090 (Docker) or http://localhost:9090 (standalone)
# 5. Click "Save & Test"

# Import dashboards:
# 1. Go to Dashboards → Import
# 2. Upload JSON files from grafana/dashboards/:
#    - kafka-events-dashboard.json
#    - redis-cache-dashboard.json
#    - temporal-workflows-dashboard.json
# 3. Select "Prometheus" as data source
# 4. Click "Import"
```

### Step 6: Deploy External Services

#### Temporal Server:

**With Docker:**
```bash
docker run -d --name temporal \
  -p 7233:7233 \
  -p 8233:8233 \
  temporalio/auto-setup:latest
```

**Without Docker:**
```bash
# Download Temporal CLI
curl -sSf https://temporal.download/cli.sh | sh

# Start Temporal dev server
temporal server start-dev
```

#### Keycloak Server:

**With Docker:**
```bash
docker run -d --name keycloak \
  -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev
```

**Without Docker:**
```bash
# Download Keycloak
wget https://github.com/keycloak/keycloak/releases/download/23.0.0/keycloak-23.0.0.tar.gz
tar xzf keycloak-23.0.0.tar.gz
cd keycloak-23.0.0

# Start Keycloak
export KEYCLOAK_ADMIN=admin
export KEYCLOAK_ADMIN_PASSWORD=admin
bin/kc.sh start-dev
```

**Configure Keycloak:**
Follow the detailed guide in `docs/KEYCLOAK_SETUP_GUIDE.md`

#### Kafka Cluster:

**With Docker:**
```bash
# Create docker-compose.kafka.yml
cat > docker-compose.kafka.yml << 'EOF'
version: '3.8'
services:
  zookeeper:
    image: confluentinc/cp-zookeeper:latest
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
    ports:
      - "2181:2181"

  kafka:
    image: confluentinc/cp-kafka:latest
    depends_on:
      - zookeeper
    ports:
      - "9092:9092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
EOF

# Start Kafka
docker-compose -f docker-compose.kafka.yml up -d
```

**Create Topics:**
```bash
# Install Kafka CLI tools
# Then create topics:
kafka-topics --create --topic user-events --bootstrap-server localhost:9092
kafka-topics --create --topic asset-events --bootstrap-server localhost:9092
kafka-topics --create --topic payment-events --bootstrap-server localhost:9092
kafka-topics --create --topic trading-events --bootstrap-server localhost:9092
kafka-topics --create --topic transaction-events --bootstrap-server localhost:9092
kafka-topics --create --topic notification-events --bootstrap-server localhost:9092
kafka-topics --create --topic audit-events --bootstrap-server localhost:9092
kafka-topics --create --topic system-events --bootstrap-server localhost:9092
kafka-topics --create --topic error-events --bootstrap-server localhost:9092
kafka-topics --create --topic analytics-events --bootstrap-server localhost:9092
```

#### Redis Server:

**With Docker:**
```bash
docker run -d --name redis \
  -p 6379:6379 \
  redis:latest
```

**Without Docker:**
```bash
sudo apt-get install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

### Step 7: Run Security Hardening

```bash
# Run security hardening script
sudo DOMAIN=vpp-platform.yourdomain.com \
     EMAIL=admin@yourdomain.com \
     ENVIRONMENT=production \
     ./scripts/security-hardening.sh
```

**This script will:**
- Update system packages
- Install security tools (UFW, Fail2Ban, Certbot, Nginx)
- Configure firewall rules
- Generate SSL certificates
- Set up Nginx reverse proxy with TLS
- Configure rate limiting
- Enable audit logging
- Secure file permissions

### Step 8: Set Up Secrets Management

```bash
# Run secrets management setup wizard
./scripts/setup-secrets-manager.sh

# Choose option:
# 1) AWS Secrets Manager
# 2) HashiCorp Vault
# 3) Encrypted .env files (dotenv-vault)
```

### Step 9: Deploy Application

```bash
# Start web server and Temporal worker with PM2
pnpm run pm2:start

# Verify processes are running
pm2 status

# View logs
pm2 logs

# Monitor processes
pm2 monit
```

### Step 10: Deploy Lakehouse ETL Pipeline

```bash
# Create Python virtual environment
cd server/integration
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Create Iceberg warehouse directory
mkdir -p /tmp/iceberg-warehouse

# Start ETL service (systemd)
sudo cp /home/ubuntu/vpp_consumer_platform/docs/LAKEHOUSE_ETL_DEPLOYMENT.md /etc/systemd/system/vpp-lakehouse-etl.service
sudo systemctl enable vpp-lakehouse-etl
sudo systemctl start vpp-lakehouse-etl

# Or run manually
python lakehouse-etl.py
```

### Step 11: Run Tests

```bash
# Run automated test suite
./scripts/run-all-tests.sh

# Review test results
cat TEST_EXECUTION_REPORT.md
```

### Step 12: Verify Deployment

```bash
# Check application health
curl http://localhost:3000/health

# Check Prometheus
curl http://localhost:9090/-/healthy

# Check Grafana
curl http://localhost:3001/api/health

# Check Temporal worker
pm2 logs vpp-temporal-worker

# Run security monitor
./scripts/security-monitor.sh
```

---

## Post-Deployment Configuration

### Configure Alert Notifications

Edit `alertmanager/config.yml` to add your notification channels:

```yaml
receivers:
  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK'
        channel: '#vpp-alerts'

  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: 'YOUR_PAGERDUTY_SERVICE_KEY'
```

### Set Up Backup Strategy

```bash
# Database backups (daily)
crontab -e
# Add: 0 2 * * * PGPASSWORD=password pg_dump -U user vpp_platform > /backups/vpp_$(date +\%Y\%m\%d).sql

# Configuration backups (weekly)
# Add: 0 3 * * 0 tar czf /backups/config_$(date +\%Y\%m\%d).tar.gz /home/ubuntu/vpp_consumer_platform
```

### Configure Auto-Scaling

For Temporal workers:

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'vpp-temporal-worker',
    script: 'tsx',
    args: 'server/workflows/worker.ts',
    instances: 4, // Increase for more workers
    exec_mode: 'cluster',
    autorestart: true,
    max_memory_restart: '1G'
  }]
};
```

---

## Troubleshooting

### Application Won't Start

```bash
# Check logs
pm2 logs

# Check environment variables
cat .env

# Check database connection
pnpm db:push

# Restart services
pm2 restart all
```

### Monitoring Stack Issues

```bash
# Check Docker services
docker-compose -f docker-compose.monitoring.yml ps

# View logs
docker-compose -f docker-compose.monitoring.yml logs

# Restart services
docker-compose -f docker-compose.monitoring.yml restart
```

### External Services Not Connecting

```bash
# Test Temporal connection
telnet localhost 7233

# Test Keycloak connection
curl http://localhost:8080

# Test Kafka connection
telnet localhost 9092

# Test Redis connection
redis-cli ping
```

### Security Issues

```bash
# Check firewall status
sudo ufw status

# Check Fail2Ban status
sudo fail2ban-client status

# Check SSL certificates
sudo certbot certificates

# View security logs
sudo journalctl -u fail2ban -f
```

---

## Maintenance Tasks

### Daily
- Monitor Grafana dashboards for anomalies
- Check application logs for errors
- Verify backup completion

### Weekly
- Review security logs
- Check for system updates
- Analyze performance metrics

### Monthly
- Rotate secrets and passwords
- Review and update firewall rules
- Conduct security audit
- Test disaster recovery procedures

---

## Useful Commands

### Application Management
```bash
# Start application
pnpm run pm2:start

# Stop application
pm2 stop all

# Restart application
pm2 restart all

# View logs
pm2 logs

# Monitor processes
pm2 monit
```

### Monitoring
```bash
# View Prometheus metrics
curl http://localhost:9090/api/v1/query?query=up

# Test alert rules
promtool check rules prometheus/alerts/*.yml

# View Grafana dashboards
open http://localhost:3001
```

### Security
```bash
# Run security hardening
sudo ./scripts/security-hardening.sh

# Run security monitor
./scripts/security-monitor.sh

# Check firewall rules
sudo ufw status verbose

# View Fail2Ban logs
sudo journalctl -u fail2ban -f
```

### Database
```bash
# Push schema changes
pnpm db:push

# Open database studio
pnpm db:studio

# Backup database
PGPASSWORD=password pg_dump -U user vpp_platform > backup.sql

# Restore database
PGPASSWORD=password psql -U user -d vpp_platform < backup.sql
```

---

## Support and Resources

### Documentation
- [Production Deployment Checklist](PRODUCTION_DEPLOYMENT_CHECKLIST.md)
- [Test Execution Report](TEST_EXECUTION_REPORT.md)
- [Middleware Deployment Guide](docs/MIDDLEWARE_DEPLOYMENT_GUIDE.md)
- [Grafana Setup Guide](docs/GRAFANA_SETUP_GUIDE.md)
- [Production Security Guide](docs/PRODUCTION_SECURITY_GUIDE.md)
- [Keycloak Setup Guide](docs/KEYCLOAK_SETUP_GUIDE.md)
- [Lakehouse ETL Deployment](docs/LAKEHOUSE_ETL_DEPLOYMENT.md)
- [Temporal Worker Deployment](docs/TEMPORAL_WORKER_DEPLOYMENT.md)

### External Resources
- [Temporal Documentation](https://docs.temporal.io/)
- [Keycloak Documentation](https://www.keycloak.org/documentation)
- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [Kafka Documentation](https://kafka.apache.org/documentation/)

### Getting Help
- Review troubleshooting sections in documentation
- Check logs for error messages
- Consult external documentation
- Contact support team

---

## Deployment Checklist

Use `PRODUCTION_DEPLOYMENT_CHECKLIST.md` for comprehensive deployment verification.

**Quick Checklist:**
- [ ] Environment variables configured
- [ ] Database schema migrated
- [ ] External services deployed (Temporal, Keycloak, Kafka, Redis)
- [ ] Monitoring stack deployed (Prometheus, Grafana)
- [ ] Security hardening complete (TLS, Firewall, Secrets)
- [ ] Application started with PM2
- [ ] All tests passing
- [ ] Grafana dashboards configured
- [ ] Alert notifications configured
- [ ] Backup strategy implemented

---

## Next Steps

After successful deployment:

1. **Monitor Performance** - Watch Grafana dashboards for the first 24 hours
2. **Load Testing** - Conduct load testing with realistic workloads
3. **Security Audit** - Review security configurations and logs
4. **User Acceptance Testing** - Have users test all critical flows
5. **Documentation** - Document any custom configurations or procedures

---

**Deployment Status:** Ready for Production  
**Estimated Deployment Time:** 2-3 hours (with external services)  
**Support:** ops-team@vpp-platform.com
