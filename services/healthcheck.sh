#!/bin/bash

set -e

echo "=== VPP Platform Health Check ==="
echo

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_service() {
    local service=$1
    local port=$2
    
    if docker-compose ps | grep -q "$service.*Up"; then
        echo -e "${GREEN}✓${NC} $service is running"
        return 0
    else
        echo -e "${RED}✗${NC} $service is NOT running"
        return 1
    fi
}

check_port() {
    local name=$1
    local host=$2
    local port=$3
    
    if nc -z -w5 "$host" "$port" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} $name is listening on $host:$port"
        return 0
    else
        echo -e "${RED}✗${NC} $name is NOT listening on $host:$port"
        return 1
    fi
}

check_fluvio_topic() {
    local topic=$1
    
    if docker-compose exec -T fluvio fluvio topic list | grep -q "$topic"; then
        echo -e "${GREEN}✓${NC} Fluvio topic '$topic' exists"
        return 0
    else
        echo -e "${YELLOW}!${NC} Fluvio topic '$topic' does NOT exist"
        return 1
    fi
}

# Check Docker services
echo "Checking Docker services..."
check_service "mosquitto" || true
check_service "fluvio" || true
check_service "mqtt-fluvio-bridge" || true
check_service "database-consumer" || true
check_service "analytics-consumer" || true
echo

# Check ports
echo "Checking network ports..."
check_port "MQTT (plain)" "localhost" 1883 || true
check_port "MQTT (TLS)" "localhost" 8883 || true
check_port "Fluvio" "localhost" 9003 || true
echo

# Check Fluvio topics
echo "Checking Fluvio topics..."
check_fluvio_topic "telemetry" || true
check_fluvio_topic "device-status" || true
echo

# Check recent logs for errors
echo "Checking recent logs for errors..."
error_count=$(docker-compose logs --tail=100 2>&1 | grep -i "error" | wc -l)
if [ "$error_count" -gt 0 ]; then
    echo -e "${YELLOW}!${NC} Found $error_count error messages in recent logs"
    echo "  Run 'docker-compose logs' to investigate"
else
    echo -e "${GREEN}✓${NC} No errors in recent logs"
fi
echo

# Check database connection
echo "Checking database connection..."
if docker-compose logs database-consumer | grep -q "Database connected"; then
    echo -e "${GREEN}✓${NC} Database consumer connected to database"
else
    echo -e "${RED}✗${NC} Database consumer NOT connected"
fi
echo

# Summary
echo "=== Health Check Complete ==="
echo
echo "To view detailed logs:"
echo "  docker-compose logs -f [service-name]"
echo
echo "To restart a service:"
echo "  docker-compose restart [service-name]"
echo
