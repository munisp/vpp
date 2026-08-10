#!/bin/bash

# VPP Platform Health Check Script
# Verifies all services are running correctly

set -e

echo "========================================="
echo "VPP Platform Health Check"
echo "========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CHECKS_PASSED=0
CHECKS_FAILED=0

check_service() {
    local service_name=$1
    local check_command=$2
    
    echo -n "Checking $service_name... "
    
    if eval "$check_command" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ OK${NC}"
        ((CHECKS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        ((CHECKS_FAILED++))
        return 1
    fi
}

check_http() {
    local name=$1
    local url=$2
    local expected_code=${3:-200}
    
    echo -n "Checking $name... "
    
    local status_code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
    
    if [ "$status_code" = "$expected_code" ]; then
        echo -e "${GREEN}✓ OK${NC} (HTTP $status_code)"
        ((CHECKS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC} (HTTP $status_code, expected $expected_code)"
        ((CHECKS_FAILED++))
        return 1
    fi
}

echo "System Services:"
echo "---------------"
check_service "VPP Application" "systemctl is-active vpp-platform"
check_service "Nginx" "systemctl is-active nginx"
check_service "MySQL" "systemctl is-active mysql"
check_service "Docker" "systemctl is-active docker"
echo ""

echo "Application Endpoints:"
echo "---------------------"
check_http "Main Application" "http://localhost:3000"
check_http "API Health" "http://localhost:3000/api/health"
echo ""

echo "Docker Services:"
echo "---------------"
if command -v docker-compose &> /dev/null; then
    COMPOSE_FILE="/opt/vpp-platform/app/services/docker-compose.yml"
    
    if [ -f "$COMPOSE_FILE" ]; then
        cd "$(dirname $COMPOSE_FILE)"
        
        # Check each service
        for service in mosquitto fluvio prometheus grafana; do
            if docker-compose ps | grep -q "$service.*Up"; then
                echo -e "$service: ${GREEN}✓ Running${NC}"
                ((CHECKS_PASSED++))
            else
                echo -e "$service: ${RED}✗ Not running${NC}"
                ((CHECKS_FAILED++))
            fi
        done
    else
        echo -e "${YELLOW}⚠ Docker Compose file not found${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Docker Compose not installed${NC}"
fi
echo ""

echo "Database Connection:"
echo "-------------------"
if command -v mysql &> /dev/null; then
    if mysql -e "SELECT 1" > /dev/null 2>&1; then
        echo -e "MySQL: ${GREEN}✓ Connected${NC}"
        ((CHECKS_PASSED++))
        
        # Check if VPP database exists
        if mysql -e "USE vpp_platform" > /dev/null 2>&1; then
            echo -e "VPP Database: ${GREEN}✓ Exists${NC}"
            ((CHECKS_PASSED++))
        else
            echo -e "VPP Database: ${RED}✗ Not found${NC}"
            ((CHECKS_FAILED++))
        fi
    else
        echo -e "MySQL: ${RED}✗ Connection failed${NC}"
        ((CHECKS_FAILED++))
    fi
else
    echo -e "${YELLOW}⚠ MySQL client not installed${NC}"
fi
echo ""

echo "Monitoring Services:"
echo "-------------------"
check_http "Prometheus" "http://localhost:9090/-/healthy" "200"
check_http "Grafana" "http://localhost:3001/api/health" "200"
echo ""

echo "MQTT Broker:"
echo "-----------"
if command -v mosquitto_sub &> /dev/null; then
    if timeout 2 mosquitto_sub -h localhost -t '$SYS/broker/version' -C 1 > /dev/null 2>&1; then
        echo -e "Mosquitto: ${GREEN}✓ Running${NC}"
        ((CHECKS_PASSED++))
    else
        echo -e "Mosquitto: ${RED}✗ Not responding${NC}"
        ((CHECKS_FAILED++))
    fi
else
    echo -e "${YELLOW}⚠ Mosquitto client not installed${NC}"
fi
echo ""

echo "Disk Space:"
echo "----------"
df -h / | tail -1 | awk '{
    used = substr($5, 1, length($5)-1);
    if (used > 90) {
        printf "\033[0;31m✗ Critical: %s used\033[0m\n", $5;
    } else if (used > 75) {
        printf "\033[1;33m⚠ Warning: %s used\033[0m\n", $5;
    } else {
        printf "\033[0;32m✓ OK: %s used\033[0m\n", $5;
    }
}'
echo ""

echo "Memory Usage:"
echo "------------"
free -h | grep Mem | awk '{
    used = $3;
    total = $2;
    printf "Used: %s / %s\n", used, total;
}'
echo ""

echo "========================================="
echo "Health Check Summary"
echo "========================================="
echo -e "Passed: ${GREEN}$CHECKS_PASSED${NC}"
echo -e "Failed: ${RED}$CHECKS_FAILED${NC}"
echo ""

if [ $CHECKS_FAILED -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
    exit 0
else
    echo -e "${RED}Some checks failed!${NC} Please investigate the issues above."
    exit 1
fi
