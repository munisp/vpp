#!/bin/bash

# Lakehouse ETL Pipeline Test Script
# Tests all aspects of Lakehouse ETL deployment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ETL_DIR="$PROJECT_DIR/server/integration"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Configuration
KAFKA_BOOTSTRAP=${KAFKA_BOOTSTRAP_SERVERS:-localhost:9092}
ICEBERG_WAREHOUSE=${ICEBERG_WAREHOUSE_PATH:-/tmp/iceberg-warehouse}

# Function to print test result
print_result() {
    local test_name=$1
    local result=$2
    local message=$3
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    if [ "$result" = "PASS" ]; then
        echo -e "${GREEN}✓ PASS${NC} - $test_name"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}✗ FAIL${NC} - $test_name: $message"
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
}

echo "========================================="
echo "Lakehouse ETL Pipeline Tests"
echo "========================================="
echo ""

# Test 1: Python installation
echo "Test 1: Python Installation"
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version)
    print_result "Python Installation" "PASS" "$PYTHON_VERSION"
else
    print_result "Python Installation" "FAIL" "Python3 not installed"
fi
echo ""

# Test 2: ETL script exists
echo "Test 2: ETL Script"
if [ -f "$ETL_DIR/lakehouse-etl.py" ]; then
    print_result "ETL Script File" "PASS"
else
    print_result "ETL Script File" "FAIL" "lakehouse-etl.py not found"
fi
echo ""

# Test 3: Requirements file exists
echo "Test 3: Requirements File"
if [ -f "$ETL_DIR/requirements.txt" ]; then
    print_result "Requirements File" "PASS"
else
    print_result "Requirements File" "FAIL" "requirements.txt not found"
fi
echo ""

# Test 4: Virtual environment
echo "Test 4: Virtual Environment"
if [ -d "$ETL_DIR/venv" ]; then
    print_result "Virtual Environment" "PASS" "venv directory exists"
else
    print_result "Virtual Environment" "FAIL" "venv not created (run: python3 -m venv venv)"
fi
echo ""

# Test 5: Python dependencies (if venv exists)
echo "Test 5: Python Dependencies"
if [ -d "$ETL_DIR/venv" ]; then
    source "$ETL_DIR/venv/bin/activate" 2>/dev/null || true
    DEPS_OK=true
    
    for pkg in confluent-kafka pandas pyiceberg pyarrow; do
        if ! python3 -c "import ${pkg//-/_}" 2>/dev/null; then
            echo -e "${YELLOW}  ⚠ Missing: $pkg${NC}"
            DEPS_OK=false
        fi
    done
    
    if [ "$DEPS_OK" = true ]; then
        print_result "Python Dependencies" "PASS" "All dependencies installed"
    else
        print_result "Python Dependencies" "FAIL" "Some dependencies missing"
    fi
    deactivate 2>/dev/null || true
else
    echo -e "${YELLOW}⊘ SKIP${NC} - Python Dependencies: Virtual environment not created"
fi
echo ""

# Test 6: Kafka connectivity
echo "Test 6: Kafka Connectivity"
KAFKA_HOST=$(echo $KAFKA_BOOTSTRAP | cut -d: -f1)
KAFKA_PORT=$(echo $KAFKA_BOOTSTRAP | cut -d: -f2)
if timeout 5 bash -c "cat < /dev/null > /dev/tcp/$KAFKA_HOST/$KAFKA_PORT" 2>/dev/null; then
    print_result "Kafka Connection" "PASS" "Connected to $KAFKA_BOOTSTRAP"
else
    print_result "Kafka Connection" "FAIL" "Cannot connect to $KAFKA_BOOTSTRAP"
fi
echo ""

# Test 7: Iceberg warehouse directory
echo "Test 7: Iceberg Warehouse Directory"
if [ -d "$ICEBERG_WAREHOUSE" ]; then
    if [ -w "$ICEBERG_WAREHOUSE" ]; then
        print_result "Warehouse Directory" "PASS" "Directory exists and writable: $ICEBERG_WAREHOUSE"
    else
        print_result "Warehouse Directory" "FAIL" "Directory not writable: $ICEBERG_WAREHOUSE"
    fi
else
    print_result "Warehouse Directory" "FAIL" "Directory does not exist: $ICEBERG_WAREHOUSE"
fi
echo ""

# Test 8: ETL service status (systemd)
echo "Test 8: ETL Service Status (systemd)"
if systemctl list-unit-files | grep -q "vpp-lakehouse-etl.service"; then
    SERVICE_STATUS=$(systemctl is-active vpp-lakehouse-etl 2>/dev/null || echo "inactive")
    if [ "$SERVICE_STATUS" = "active" ]; then
        print_result "ETL Service Status" "PASS" "Service is $SERVICE_STATUS"
    else
        print_result "ETL Service Status" "FAIL" "Service is $SERVICE_STATUS"
    fi
else
    echo -e "${YELLOW}⊘ SKIP${NC} - ETL Service Status: Service not installed"
fi
echo ""

# Test 9: Kafka consumer group
echo "Test 9: Kafka Consumer Group"
if command -v docker &> /dev/null && docker ps | grep -q kafka; then
    CONSUMER_GROUP=$(docker exec nextgen_kafka kafka-consumer-groups \
        --bootstrap-server localhost:9092 \
        --list 2>/dev/null | grep "lakehouse-etl" || echo "")
    
    if [ -n "$CONSUMER_GROUP" ]; then
        print_result "Kafka Consumer Group" "PASS" "Group 'lakehouse-etl' exists"
    else
        print_result "Kafka Consumer Group" "FAIL" "Consumer group not found (ETL not started yet)"
    fi
else
    echo -e "${YELLOW}⊘ SKIP${NC} - Kafka Consumer Group: Docker or Kafka not available"
fi
echo ""

# Test 10: ETL deployment guide
echo "Test 10: ETL Deployment Guide"
if [ -f "$PROJECT_DIR/docs/LAKEHOUSE_ETL_DEPLOYMENT.md" ]; then
    print_result "Deployment Guide" "PASS" "Documentation available"
else
    print_result "Deployment Guide" "FAIL" "Deployment guide not found"
fi
echo ""

# Summary
echo "========================================="
echo "Test Summary"
echo "========================================="
echo "Total Tests: $TOTAL_TESTS"
echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
echo -e "Failed: ${RED}$FAILED_TESTS${NC}"
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Create virtual environment: cd $ETL_DIR && python3 -m venv venv"
    echo "2. Install dependencies: source venv/bin/activate && pip install -r requirements.txt"
    echo "3. Run ETL: python lakehouse-etl.py"
    exit 0
else
    echo -e "${RED}Some tests failed. Please review the output above.${NC}"
    exit 1
fi
