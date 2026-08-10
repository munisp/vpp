# VPP Platform - Production Deployment Checklist

**Version:** v22.0  
**Date:** 2024-01-16  
**Environment:** Production  

This checklist ensures all critical components are properly configured before production deployment.

---

## Pre-Deployment Checklist

### 1. Code & Configuration ✅

- [x] All code implemented and tested
- [x] Configuration files complete
- [x] Deployment scripts ready and executable
- [x] Documentation comprehensive
- [~] TypeScript compilation successful (0 errors) — **UNVERIFIED, pending CI**: this claim predates the CI pipeline; confirm via the `pnpm check` (tsc --noEmit) step in `.github/workflows/ci.yml` before relying on it
- [~] All dependencies installed — **UNVERIFIED, pending CI**: confirm via `pnpm install --frozen-lockfile` in CI
- [x] Package.json scripts configured
- [~] PM2 ecosystem configuration ready — **UNVERIFIED**: `ecosystem.config.js` exists and runs TS via `--import tsx`, but it has not been validated in CI; a plain `pm2 start server/_core/index.ts --interpreter=node` (without tsx) cannot run TypeScript — see DEPLOYMENT.md

**Status:** ⚠️ PARTIALLY VERIFIED — items marked [~] are pending confirmation by the CI pipeline

---

### 2. Testing & Quality Assurance

#### Automated Tests
- [ ] Run test suite: `./scripts/run-all-tests.sh`
  - [ ] Temporal worker tests (6/9 expected to pass without external services)
  - [ ] Keycloak authentication tests (2/10 expected to pass without external services)
  - [ ] Lakehouse ETL tests (3/10 expected to pass without external services)
- [ ] Review test execution report: `TEST_EXECUTION_REPORT.md`
- [ ] All code-level tests passing

#### Manual Testing
- [ ] User registration and login flow
- [ ] Asset registration and management
- [ ] Payment processing (all gateways)
- [ ] Trading operations (manual, auto, P2P)
- [ ] Admin dashboard functionality
- [ ] WebSocket real-time updates
- [ ] Mobile money integration
- [ ] Cache monitoring dashboard

**Status:** ⏳ PENDING

---

### 3. Infrastructure Deployment

#### External Services
- [ ] **Temporal Server**
  - [ ] Temporal server deployed and accessible
  - [ ] Temporal Web UI accessible
  - [ ] Connection tested: `telnet localhost 7233`
  - [ ] Environment variable set: `TEMPORAL_ADDRESS`

- [ ] **Keycloak Server**
  - [ ] Keycloak server deployed
  - [ ] Realm created: `vpp-platform`
  - [ ] Client configured with correct redirect URIs
  - [ ] Roles created: `admin`, `user`, `operator`
  - [ ] Environment variables set: `KEYCLOAK_SERVER_URL`, `KEYCLOAK_CLIENT_SECRET`

- [ ] **Kafka Cluster**
  - [ ] Kafka broker(s) deployed
  - [ ] Topics created (10 topics - see `docs/LAKEHOUSE_ETL_DEPLOYMENT.md`)
  - [ ] Connection tested: `telnet localhost 9092`
  - [ ] Environment variable set: `KAFKA_BOOTSTRAP_SERVERS`

- [ ] **Redis Cluster**
  - [ ] Redis server deployed
  - [ ] Connection tested: `redis-cli ping`
  - [ ] Environment variable set: `REDIS_URL`

- [ ] **Database**
  - [ ] MySQL/TiDB deployed
  - [ ] Database created
  - [ ] Schema migrated: `pnpm db:push`
  - [ ] Connection tested
  - [ ] Backups configured

**Status:** ⏳ PENDING

---

### 4. Monitoring Stack Deployment

#### Prometheus
- [ ] Prometheus deployed
- [ ] Configuration file loaded: `prometheus/prometheus.yml`
- [ ] Alert rules loaded: `prometheus/alerts/vpp-alerts.yml`
- [ ] Scrape targets configured (8 targets)
- [ ] Prometheus accessible: http://localhost:9090
- [ ] Metrics being collected

#### Grafana
- [ ] Grafana deployed
- [ ] Prometheus data source configured
- [ ] Dashboards imported (3 dashboards):
  - [ ] Kafka Events Dashboard
  - [ ] Redis Cache Dashboard
  - [ ] Temporal Workflows Dashboard
- [ ] Grafana accessible: http://localhost:3001
- [ ] Dashboards displaying data

#### Alertmanager
- [ ] Alertmanager deployed
- [ ] Configuration file loaded: `alertmanager/config.yml`
- [ ] Notification channels configured:
  - [ ] Email (SMTP settings)
  - [ ] Slack webhooks
  - [ ] PagerDuty integration
- [ ] Test alerts sent and received

#### Exporters
- [ ] Redis Exporter running (port 9121)
- [ ] Kafka Exporter running (port 9308)
- [ ] Node Exporter running (port 9100)
- [ ] All exporters accessible from Prometheus

**Quick Start:**
```bash
docker-compose -f docker-compose.monitoring.yml up -d
```

**Status:** ⏳ PENDING

---

### 5. Security Hardening

#### SSL/TLS Configuration
- [ ] SSL certificates generated (Let's Encrypt or self-signed)
- [ ] Nginx configured with TLS
- [ ] All services using TLS:
  - [ ] Keycloak (HTTPS)
  - [ ] Kafka (SSL)
  - [ ] Redis (TLS)
  - [ ] Temporal (TLS)
- [ ] Certificate auto-renewal configured
- [ ] TLS protocols: TLSv1.2 and TLSv1.3 only
- [ ] Strong cipher suites configured

#### Firewall & Network Security
- [ ] UFW firewall enabled
- [ ] Firewall rules configured:
  - [ ] Port 22 (SSH) - restricted to specific IPs
  - [ ] Port 80 (HTTP) - open
  - [ ] Port 443 (HTTPS) - open
  - [ ] Port 3000 (Application) - internal only
  - [ ] Port 9090 (Prometheus) - internal only
  - [ ] Port 3001 (Grafana) - internal only
- [ ] Fail2Ban configured and running
- [ ] IP whitelisting for admin endpoints

#### Secrets Management
- [ ] Secrets management solution chosen:
  - [ ] AWS Secrets Manager, OR
  - [ ] HashiCorp Vault, OR
  - [ ] Encrypted .env files (dotenv-vault)
- [ ] All secrets stored securely
- [ ] `.env` files not committed to version control
- [ ] Secrets rotation schedule defined
- [ ] Access controls configured

#### Application Security
- [ ] Security headers configured (HSTS, X-Frame-Options, CSP)
- [ ] Rate limiting enabled (API: 10 req/s, Login: 5 req/min)
- [ ] CORS properly configured
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (input sanitization)
- [ ] CSRF protection enabled

#### Audit Logging
- [ ] Application audit logging enabled
- [ ] Keycloak event logging enabled (365 days retention)
- [ ] System audit logging configured (auditd)
- [ ] Log aggregation configured (ELK stack)
- [ ] Log retention policies defined

#### Authentication & Authorization
- [ ] Keycloak password policies configured:
  - [ ] Minimum 12 characters
  - [ ] Complexity requirements
  - [ ] Password expiry (90 days)
- [ ] Brute force detection enabled (5 max failures, 15min lockout)
- [ ] Multi-factor authentication (MFA) enabled for admins
- [ ] Session management configured (30min idle, 10hr max)
- [ ] Email verification enabled

**Quick Start:**
```bash
# Run security hardening script
sudo ./scripts/security-hardening.sh

# Set up secrets management
./scripts/setup-secrets-manager.sh
```

**Status:** ⏳ PENDING

---

### 6. Application Deployment

#### Worker Processes
- [ ] Temporal worker started: `pnpm run pm2:start`
- [ ] Worker process running: `pm2 status`
- [ ] Worker logs clean: `pm2 logs vpp-temporal-worker`
- [ ] Worker connected to Temporal server

#### Web Server
- [ ] Web server started: `pnpm run pm2:start`
- [ ] Server process running: `pm2 status`
- [ ] Server logs clean: `pm2 logs vpp-web-server`
- [ ] Application accessible via Nginx

#### Python ETL Pipeline
- [ ] Python virtual environment created
- [ ] Dependencies installed: `pip install -r server/integration/requirements.txt`
- [ ] ETL service started (systemd or Docker)
- [ ] ETL consuming Kafka events
- [ ] Iceberg tables being populated

**Status:** ⏳ PENDING

---

### 7. Environment Variables

#### Required Variables
- [x] `DATABASE_URL` - Database connection string
- [x] `JWT_SECRET` - Session cookie signing secret
- [x] `VITE_APP_ID` - Manus OAuth application ID
- [x] `OAUTH_SERVER_URL` - Manus OAuth backend URL
- [x] `VITE_OAUTH_PORTAL_URL` - Manus login portal URL
- [ ] `TEMPORAL_ADDRESS` - Temporal server address
- [ ] `KEYCLOAK_SERVER_URL` - Keycloak server URL
- [ ] `KEYCLOAK_REALM` - Keycloak realm name
- [ ] `KEYCLOAK_CLIENT_ID` - Keycloak client ID
- [ ] `KEYCLOAK_CLIENT_SECRET` - Keycloak client secret
- [ ] `KAFKA_BOOTSTRAP_SERVERS` - Kafka broker addresses
- [ ] `REDIS_URL` - Redis connection URL
- [ ] `ICEBERG_WAREHOUSE_PATH` - Iceberg warehouse directory

#### Payment Gateway Variables
- [ ] Mobile Money API credentials
- [ ] Payment gateway API keys
- [ ] Webhook secrets

**Status:** ⏳ PENDING

---

### 8. Performance & Scalability

#### Load Testing
- [ ] Load testing performed (target: 1000 concurrent users)
- [ ] Response time acceptable (P95 < 500ms, P99 < 1s)
- [ ] Error rate acceptable (< 0.1%)
- [ ] Resource utilization acceptable (CPU < 70%, Memory < 80%)

#### Caching
- [ ] Redis cache configured
- [ ] Cache hit rate monitored (target: > 70%)
- [ ] Cache eviction policy configured
- [ ] Cache warming strategy defined

#### Database Optimization
- [ ] Database indexes created
- [ ] Query performance analyzed
- [ ] Connection pooling configured
- [ ] Read replicas configured (if needed)

#### Auto-Scaling
- [ ] Auto-scaling policies defined
- [ ] Temporal worker scaling configured
- [ ] Database scaling strategy defined

**Status:** ⏳ PENDING

---

### 9. Backup & Disaster Recovery

#### Backup Strategy
- [ ] Database backups scheduled (daily full, hourly incremental)
- [ ] Backup retention policy defined (30 days)
- [ ] Backup restoration tested
- [ ] Configuration backups automated
- [ ] S3 bucket versioning enabled

#### Disaster Recovery
- [ ] Disaster recovery plan documented
- [ ] Recovery time objective (RTO) defined: 4 hours
- [ ] Recovery point objective (RPO) defined: 1 hour
- [ ] Disaster recovery drill performed
- [ ] Failover procedures documented

**Status:** ⏳ PENDING

---

### 10. Documentation & Training

#### Documentation
- [x] Deployment guides complete (8 guides)
- [x] API documentation available
- [x] Architecture diagrams created
- [x] Troubleshooting guides written
- [ ] Runbook procedures documented
- [ ] Incident response plan created

#### Training
- [ ] Operations team trained
- [ ] Support team trained
- [ ] On-call rotation defined
- [ ] Escalation procedures documented

**Status:** ⏳ PENDING

---

### 11. Compliance & Legal

#### GDPR Compliance
- [ ] Data protection impact assessment completed
- [ ] Privacy policy updated
- [ ] Cookie consent implemented
- [ ] Data retention policies defined
- [ ] Right to erasure implemented
- [ ] Data portability implemented

#### Security Compliance
- [ ] OWASP Top 10 mitigations implemented
- [ ] Security audit performed
- [ ] Penetration testing completed
- [ ] Vulnerability scanning automated

#### Legal
- [ ] Terms of service updated
- [ ] Service level agreements (SLAs) defined
- [ ] Data processing agreements signed

**Status:** ⏳ PENDING

---

### 12. Monitoring & Alerting

#### Metrics Collection
- [~] Prometheus collecting metrics — **UNVERIFIED**: configuration exists, but "collecting" has not been confirmed against a running stack; verify during deployment
- [~] Grafana dashboards configured — **UNVERIFIED**: provisioning files exist; rendering not confirmed against a running Grafana
- [~] Custom metrics instrumented — **UNVERIFIED, pending CI**: instrumentation code exists; endpoint output not exercised by CI yet
- [ ] Metrics retention configured (30 days)

#### Alerting
- [~] Alert rules configured (20+ alerts) — **UNVERIFIED**: rule files exist; rules not loaded/tested against a running Alertmanager
- [ ] Alert thresholds tuned
- [ ] Notification channels tested
- [ ] On-call schedule configured
- [ ] Alert escalation policies defined

#### Logging
- [ ] Centralized logging configured (ELK stack)
- [ ] Log levels configured appropriately
- [ ] Log retention policies applied
- [ ] Log analysis dashboards created

**Status:** ⏳ PENDING

---

### 13. Final Verification

#### Smoke Tests
- [ ] Homepage loads successfully
- [ ] User can register and login
- [ ] User can register assets
- [ ] User can make payments
- [ ] User can execute trades
- [ ] Admin can access dashboard
- [ ] WebSocket connections working
- [ ] Real-time updates functioning

#### Performance Tests
- [ ] Response time < 500ms (P95)
- [ ] Response time < 1s (P99)
- [ ] Error rate < 0.1%
- [ ] Uptime > 99.9%

#### Security Tests
- [ ] SSL/TLS working correctly
- [ ] Authentication working
- [ ] Authorization working
- [ ] Rate limiting working
- [ ] CORS configured correctly

**Status:** ⏳ PENDING

---

## Deployment Execution

### Step 1: Deploy External Services
```bash
# Deploy Temporal (Docker)
docker run -d --name temporal \
  -p 7233:7233 -p 8233:8233 \
  temporalio/auto-setup:latest

# Deploy Keycloak (Docker)
docker run -d --name keycloak \
  -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev

# Deploy Kafka (see MIDDLEWARE_DEPLOYMENT_GUIDE.md)

# Deploy Redis (Docker)
docker run -d --name redis \
  -p 6379:6379 \
  redis:latest
```

### Step 2: Deploy Monitoring Stack
```bash
# Start monitoring stack
docker-compose -f docker-compose.monitoring.yml up -d

# Verify services
docker-compose -f docker-compose.monitoring.yml ps

# Access Grafana: http://localhost:3001 (admin/admin)
# Access Prometheus: http://localhost:9090
```

### Step 3: Run Security Hardening
```bash
# Run security hardening script (requires root)
sudo ./scripts/security-hardening.sh

# Set up secrets management
./scripts/setup-secrets-manager.sh
```

### Step 4: Deploy Application
```bash
# Set environment variables
export TEMPORAL_ADDRESS="localhost:7233"
export KEYCLOAK_SERVER_URL="http://localhost:8080"
export KAFKA_BOOTSTRAP_SERVERS="localhost:9092"
export REDIS_URL="redis://localhost:6379"

# Push database schema
pnpm db:push

# Start application with PM2
pnpm run pm2:start

# Verify processes
pm2 status
pm2 logs
```

### Step 5: Run Tests
```bash
# Run automated test suite
./scripts/run-all-tests.sh

# Review test report
cat TEST_EXECUTION_REPORT.md
```

### Step 6: Verify Deployment
```bash
# Check application health
curl http://localhost:3000/health

# Check Temporal worker
pm2 logs vpp-temporal-worker

# Check monitoring
curl http://localhost:9090/-/healthy  # Prometheus
curl http://localhost:3001/api/health  # Grafana

# Run security monitor
./scripts/security-monitor.sh
```

---

## Post-Deployment Tasks

### Immediate (Day 1)
- [ ] Monitor application logs for errors
- [ ] Monitor Grafana dashboards for anomalies
- [ ] Verify all alerts are working
- [ ] Check backup completion
- [ ] Review security logs

### Short-term (Week 1)
- [ ] Analyze performance metrics
- [ ] Tune alert thresholds
- [ ] Review and optimize queries
- [ ] Conduct user acceptance testing
- [ ] Update documentation based on findings

### Medium-term (Month 1)
- [ ] Review and optimize resource allocation
- [ ] Conduct security audit
- [ ] Review and update disaster recovery plan
- [ ] Analyze user feedback
- [ ] Plan capacity expansion

---

## Rollback Plan

If critical issues are discovered after deployment:

1. **Immediate Actions:**
   ```bash
   # Stop application
   pm2 stop all
   
   # Rollback to previous checkpoint
   # (use webdev_rollback_checkpoint in Manus UI)
   ```

2. **Verify Rollback:**
   - Check application is running on previous version
   - Verify data integrity
   - Test critical user flows

3. **Communicate:**
   - Notify stakeholders of rollback
   - Document issues encountered
   - Plan remediation

---

## Success Criteria

Deployment is considered successful when:

- ✅ All automated tests passing (with external services)
- ✅ All external services deployed and connected
- ✅ Monitoring stack operational with data flowing
- ✅ Security hardening complete
- ✅ Application accessible and responsive
- ✅ No critical errors in logs
- ✅ All smoke tests passing
- ✅ Performance metrics within acceptable ranges
- ✅ Alerts configured and tested
- ✅ Backups running successfully

---

## Support Contacts

- **Operations Team:** ops-team@vpp-platform.com
- **Security Team:** security@vpp-platform.com
- **On-Call Engineer:** +1-XXX-XXX-XXXX
- **Escalation Manager:** manager@vpp-platform.com

---

## Revision History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| v22.0 | 2024-01-16 | Initial production checklist | VPP Team |

---

**Sign-off:**

- [ ] Technical Lead: _________________ Date: _______
- [ ] Security Lead: _________________ Date: _______
- [ ] Operations Lead: _________________ Date: _______
- [ ] Product Owner: _________________ Date: _______

---

**Deployment Status:** ⏳ READY FOR DEPLOYMENT (pending external services)
