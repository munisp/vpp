#!/bin/bash

# Temporal Worker Deployment Test Script
# Tests all aspects of Temporal worker deployment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

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
echo "Temporal Worker Deployment Tests"
echo "========================================="
echo ""

# Test 1: Check PM2 installation
echo "Test 1: PM2 Installation"
if command -v pm2 &> /dev/null; then
    PM2_VERSION=$(pm2 -v)
    print_result "PM2 Installation" "PASS" "Version: $PM2_VERSION"
else
    print_result "PM2 Installation" "FAIL" "PM2 not installed"
fi
echo ""

# Test 2: Check ecosystem.config.js exists
echo "Test 2: Ecosystem Configuration"
if [ -f "$PROJECT_DIR/ecosystem.config.js" ]; then
    print_result "Ecosystem Config File" "PASS"
else
    print_result "Ecosystem Config File" "FAIL" "ecosystem.config.js not found"
fi
echo ""

# Test 3: Check worker script exists
echo "Test 3: Worker Script"
if [ -f "$PROJECT_DIR/server/workflows/worker.ts" ]; then
    print_result "Worker Script File" "PASS"
else
    print_result "Worker Script File" "FAIL" "worker.ts not found"
fi
echo ""

# Test 4: Check Temporal server connectivity
echo "Test 4: Temporal Server Connectivity"
TEMPORAL_ADDRESS=${TEMPORAL_ADDRESS:-localhost:7233}
if timeout 5 bash -c "cat < /dev/null > /dev/tcp/${TEMPORAL_ADDRESS%:*}/${TEMPORAL_ADDRESS#*:}" 2>/dev/null; then
    print_result "Temporal Server Connection" "PASS" "Connected to $TEMPORAL_ADDRESS"
else
    print_result "Temporal Server Connection" "FAIL" "Cannot connect to $TEMPORAL_ADDRESS"
fi
echo ""

# Test 5: Check Temporal Web UI
echo "Test 5: Temporal Web UI"
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8233 | grep -q "200\|302"; then
    print_result "Temporal Web UI" "PASS" "UI accessible at http://localhost:8233"
else
    print_result "Temporal Web UI" "FAIL" "UI not accessible"
fi
echo ""

# Test 6: Check worker process status (if running)
echo "Test 6: Worker Process Status"
if pm2 list | grep -q "vpp-temporal-worker"; then
    WORKER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="vpp-temporal-worker") | .pm2_env.status')
    if [ "$WORKER_STATUS" = "online" ]; then
        print_result "Worker Process Status" "PASS" "Status: $WORKER_STATUS"
    else
        print_result "Worker Process Status" "FAIL" "Status: $WORKER_STATUS (expected: online)"
    fi
else
    print_result "Worker Process Status" "FAIL" "Worker not running (use 'pnpm run pm2:start' to start)"
fi
echo ""

# Test 7: Check worker logs (if running)
echo "Test 7: Worker Logs"
if pm2 list | grep -q "vpp-temporal-worker"; then
    LOG_DIR="$PROJECT_DIR/logs"
    if [ -d "$LOG_DIR" ] && [ -f "$LOG_DIR/vpp-worker-out.log" ]; then
        if grep -q "Temporal Worker" "$LOG_DIR/vpp-worker-out.log" 2>/dev/null; then
            print_result "Worker Logs" "PASS" "Logs found in $LOG_DIR"
        else
            print_result "Worker Logs" "FAIL" "No worker logs found"
        fi
    else
        print_result "Worker Logs" "FAIL" "Log directory or files not found"
    fi
else
    echo -e "${YELLOW}⊘ SKIP${NC} - Worker Logs: Worker not running"
fi
echo ""

# Test 8: Check package.json scripts
echo "Test 8: Package.json Scripts"
if grep -q "\"worker\":" "$PROJECT_DIR/package.json" && \
   grep -q "\"pm2:start\":" "$PROJECT_DIR/package.json"; then
    print_result "Package.json Scripts" "PASS" "Worker and PM2 scripts configured"
else
    print_result "Package.json Scripts" "FAIL" "Required scripts not found in package.json"
fi
echo ""

# Test 9: Check Temporal SDK dependencies
echo "Test 9: Temporal SDK Dependencies"
if [ -d "$PROJECT_DIR/node_modules/@temporalio/worker" ] && \
   [ -d "$PROJECT_DIR/node_modules/@temporalio/workflow" ] && \
   [ -d "$PROJECT_DIR/node_modules/@temporalio/client" ]; then
    print_result "Temporal SDK Dependencies" "PASS" "All Temporal packages installed"
else
    print_result "Temporal SDK Dependencies" "FAIL" "Temporal SDK packages not installed"
fi
echo ""

# Test 10: Check worker configuration
echo "Test 10: Worker Configuration"
if grep -q "payment-processing" "$PROJECT_DIR/server/workflows/worker.ts"; then
    print_result "Worker Task Queue Config" "PASS" "Task queue: payment-processing"
else
    print_result "Worker Task Queue Config" "FAIL" "Task queue not configured"
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
    exit 0
else
    echo -e "${RED}Some tests failed. Please review the output above.${NC}"
    exit 1
fi
