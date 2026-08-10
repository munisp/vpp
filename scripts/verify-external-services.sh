#!/bin/bash

# VPP Platform - External Services Verification Script
# Version: v22.0
# This script verifies that all external services are properly deployed and accessible

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "========================================="
echo "VPP Platform External Services Verification"
echo "========================================="
echo ""

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

print_pass() {
    echo -e "${GREEN}✓ PASS${NC} - $1"
    ((PASS_COUNT++))
}

print_fail() {
    echo -e "${RED}✗ FAIL${NC} - $1"
    ((FAIL_COUNT++))
}

print_warn() {
    echo -e "${YELLOW}⚠ WARN${NC} - $1"
    ((WARN_COUNT++))
}

print_info() {
    echo -e "${BLUE}ℹ INFO${NC} - $1"
}

# Test 1: Temporal Server
echo "Test 1: Temporal Server"
TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
if timeout 3 bash -c "echo > /dev/tcp/${TEMPORAL_ADDRESS%:*}/${TEMPORAL_ADDRESS#*:}" 2>/dev/null; then
    print_pass "Temporal server is accessible at $TEMPORAL_ADDRESS"
else
    print_fail "Temporal server is not accessible at $TEMPORAL_ADDRESS"
    print_info "Deploy with: docker run -d -p 7233:7233 temporalio/auto-setup:latest"
fi
echo ""

# Test 2: Keycloak Server
echo "Test 2: Keycloak Server"
KEYCLOAK_URL="${KEYCLOAK_SERVER_URL:-http://localhost:8080}"
if curl -s -o /dev/null -w "%{http_code}" "$KEYCLOAK_URL" 2>/dev/null | grep -q "200\|302"; then
    print_pass "Keycloak server is accessible at $KEYCLOAK_URL"
else
    print_fail "Keycloak server is not accessible at $KEYCLOAK_URL"
    print_info "Deploy with: docker run -d -p 8080:8080 -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:latest start-dev"
fi
echo ""

# Test 3: Kafka Broker
echo "Test 3: Kafka Broker"
KAFKA_SERVERS="${KAFKA_BOOTSTRAP_SERVERS:-localhost:9092}"
IFS=',' read -ra KAFKA_ARRAY <<< "$KAFKA_SERVERS"
for server in "${KAFKA_ARRAY[@]}"; do
    if timeout 3 bash -c "echo > /dev/tcp/${server%:*}/${server#*:}" 2>/dev/null; then
        print_pass "Kafka broker is accessible at $server"
    else
        print_fail "Kafka broker is not accessible at $server"
        print_info "Deploy with: docker-compose -f docker-compose.kafka.yml up -d"
    fi
done
echo ""

# Test 4: Redis Server
echo "Test 4: Redis Server"
REDIS_HOST=$(echo "${REDIS_URL:-redis://localhost:6379}" | sed 's|redis://||' | cut -d: -f1)
REDIS_PORT=$(echo "${REDIS_URL:-redis://localhost:6379}" | sed 's|redis://||' | cut -d: -f2 | cut -d/ -f1)
if timeout 3 bash -c "echo > /dev/tcp/$REDIS_HOST/$REDIS_PORT" 2>/dev/null; then
    print_pass "Redis server is accessible at $REDIS_HOST:$REDIS_PORT"
    
    # Test Redis ping
    if command -v redis-cli &> /dev/null; then
        if redis-cli -h $REDIS_HOST -p $REDIS_PORT ping 2>/dev/null | grep -q "PONG"; then
            print_pass "Redis server responds to PING"
        else
            print_warn "Redis server does not respond to PING"
        fi
    fi
else
    print_fail "Redis server is not accessible at $REDIS_HOST:$REDIS_PORT"
    print_info "Deploy with: docker run -d -p 6379:6379 redis:latest"
fi
echo ""

# Test 5: Database
echo "Test 5: Database Connection"
if [ -n "$DATABASE_URL" ]; then
    # Extract database host and port from connection string
    DB_HOST=$(echo "$DATABASE_URL" | sed 's|.*@||' | cut -d: -f1)
    DB_PORT=$(echo "$DATABASE_URL" | sed 's|.*:||' | cut -d/ -f1)
    
    if timeout 3 bash -c "echo > /dev/tcp/$DB_HOST/$DB_PORT" 2>/dev/null; then
        print_pass "Database server is accessible at $DB_HOST:$DB_PORT"
    else
        print_fail "Database server is not accessible at $DB_HOST:$DB_PORT"
    fi
else
    print_warn "DATABASE_URL not set in environment"
fi
echo ""

# Test 6: Prometheus
echo "Test 6: Prometheus"
if curl -s http://localhost:9090/-/healthy 2>/dev/null | grep -q "Prometheus"; then
    print_pass "Prometheus is running and healthy"
else
    print_fail "Prometheus is not accessible"
    print_info "Deploy with: ./scripts/deploy-prometheus.sh"
fi
echo ""

# Test 7: Grafana
echo "Test 7: Grafana"
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/health 2>/dev/null | grep -q "200"; then
    print_pass "Grafana is running and healthy"
else
    print_fail "Grafana is not accessible"
    print_info "Deploy with: docker-compose -f docker-compose.monitoring.yml up -d"
fi
echo ""

# Test 8: Alertmanager
echo "Test 8: Alertmanager"
if curl -s -o /dev/null -w "%{http_code}" http://localhost:9093/-/healthy 2>/dev/null | grep -q "200"; then
    print_pass "Alertmanager is running and healthy"
else
    print_warn "Alertmanager is not accessible (optional)"
fi
echo ""

# Test 9: Redis Exporter
echo "Test 9: Redis Exporter"
if curl -s http://localhost:9121/metrics 2>/dev/null | grep -q "redis_"; then
    print_pass "Redis Exporter is running"
else
    print_warn "Redis Exporter is not accessible (optional)"
fi
echo ""

# Test 10: Kafka Exporter
echo "Test 10: Kafka Exporter"
if curl -s http://localhost:9308/metrics 2>/dev/null | grep -q "kafka_"; then
    print_pass "Kafka Exporter is running"
else
    print_warn "Kafka Exporter is not accessible (optional)"
fi
echo ""

# Test 11: Node Exporter
echo "Test 11: Node Exporter"
if curl -s http://localhost:9100/metrics 2>/dev/null | grep -q "node_"; then
    print_pass "Node Exporter is running"
else
    print_warn "Node Exporter is not accessible (optional)"
fi
echo ""

# Test 12: Kafka Topics
echo "Test 12: Kafka Topics"
if command -v kafka-topics &> /dev/null; then
    required_topics=("user-events" "asset-events" "payment-events" "trading-events" "transaction-events" "notification-events" "audit-events" "system-events" "error-events" "analytics-events")
    
    for topic in "${required_topics[@]}"; do
        if kafka-topics --bootstrap-server ${KAFKA_BOOTSTRAP_SERVERS:-localhost:9092} --list 2>/dev/null | grep -q "^$topic$"; then
            print_pass "Kafka topic '$topic' exists"
        else
            print_fail "Kafka topic '$topic' does not exist"
            print_info "Create with: kafka-topics --create --topic $topic --bootstrap-server localhost:9092"
        fi
    done
else
    print_warn "kafka-topics command not available (cannot verify topics)"
fi
echo ""

# Test 13: Keycloak Realm
echo "Test 13: Keycloak Realm Configuration"
if [ -n "$KEYCLOAK_SERVER_URL" ] && [ -n "$KEYCLOAK_REALM" ]; then
    realm_url="$KEYCLOAK_SERVER_URL/realms/$KEYCLOAK_REALM"
    if curl -s -o /dev/null -w "%{http_code}" "$realm_url" 2>/dev/null | grep -q "200"; then
        print_pass "Keycloak realm '$KEYCLOAK_REALM' is accessible"
    else
        print_fail "Keycloak realm '$KEYCLOAK_REALM' is not accessible"
        print_info "Configure realm using: docs/KEYCLOAK_SETUP_GUIDE.md"
    fi
else
    print_warn "Keycloak environment variables not set"
fi
echo ""

# Test 14: Temporal Web UI
echo "Test 14: Temporal Web UI"
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8233 2>/dev/null | grep -q "200"; then
    print_pass "Temporal Web UI is accessible at http://localhost:8233"
else
    print_warn "Temporal Web UI is not accessible (optional)"
fi
echo ""

# Test 15: Iceberg Warehouse
echo "Test 15: Iceberg Warehouse"
ICEBERG_PATH="${ICEBERG_WAREHOUSE_PATH:-/tmp/iceberg-warehouse}"
if [ -d "$ICEBERG_PATH" ]; then
    print_pass "Iceberg warehouse directory exists at $ICEBERG_PATH"
    
    if [ -w "$ICEBERG_PATH" ]; then
        print_pass "Iceberg warehouse directory is writable"
    else
        print_fail "Iceberg warehouse directory is not writable"
    fi
else
    print_fail "Iceberg warehouse directory does not exist at $ICEBERG_PATH"
    print_info "Create with: mkdir -p $ICEBERG_PATH"
fi
echo ""

# Summary
echo "========================================="
echo "External Services Verification Summary"
echo "========================================="
echo -e "${GREEN}Passed:${NC} $PASS_COUNT"
echo -e "${YELLOW}Warnings:${NC} $WARN_COUNT"
echo -e "${RED}Failed:${NC} $FAIL_COUNT"
echo ""

# Critical services check
CRITICAL_FAILS=0
if ! timeout 3 bash -c "echo > /dev/tcp/${TEMPORAL_ADDRESS%:*}/${TEMPORAL_ADDRESS#*:}" 2>/dev/null; then
    ((CRITICAL_FAILS++))
fi
if ! curl -s -o /dev/null -w "%{http_code}" "$KEYCLOAK_URL" 2>/dev/null | grep -q "200\|302"; then
    ((CRITICAL_FAILS++))
fi
if ! timeout 3 bash -c "echo > /dev/tcp/$REDIS_HOST/$REDIS_PORT" 2>/dev/null; then
    ((CRITICAL_FAILS++))
fi

if [ $CRITICAL_FAILS -eq 0 ]; then
    echo -e "${GREEN}✓ All critical services are accessible!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Start application: pnpm run pm2:start"
    echo "2. Run tests: ./scripts/run-all-tests.sh"
    echo "3. Verify deployment: ./scripts/verify-deployment.sh"
    exit 0
else
    echo -e "${RED}✗ $CRITICAL_FAILS critical service(s) not accessible!${NC}"
    echo ""
    echo "Please deploy missing services before starting the application."
    echo ""
    echo "Quick deployment commands:"
    echo "  Temporal:  docker run -d -p 7233:7233 -p 8233:8233 temporalio/auto-setup:latest"
    echo "  Keycloak:  docker run -d -p 8080:8080 -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:latest start-dev"
    echo "  Kafka:     docker-compose -f docker-compose.kafka.yml up -d"
    echo "  Redis:     docker run -d -p 6379:6379 redis:latest"
    echo ""
    echo "Or follow the complete guide: QUICK_DEPLOYMENT_GUIDE.md"
    exit 1
fi
