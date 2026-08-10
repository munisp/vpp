#!/bin/bash

# Master Test Runner
# Runs all deployment tests and generates summary report

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test suite results
TOTAL_SUITES=0
PASSED_SUITES=0
FAILED_SUITES=0

echo "========================================="
echo "VPP Platform - Deployment Test Suite"
echo "========================================="
echo ""
echo "Running all deployment tests..."
echo ""

# Test Suite 1: Temporal Worker
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}Test Suite 1: Temporal Worker${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""

TOTAL_SUITES=$((TOTAL_SUITES + 1))
if bash "$SCRIPT_DIR/test-temporal-worker.sh"; then
    PASSED_SUITES=$((PASSED_SUITES + 1))
    echo -e "${GREEN}✓ Temporal Worker Tests: PASSED${NC}"
else
    FAILED_SUITES=$((FAILED_SUITES + 1))
    echo -e "${RED}✗ Temporal Worker Tests: FAILED${NC}"
fi
echo ""
echo ""

# Test Suite 2: Keycloak Authentication
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}Test Suite 2: Keycloak Authentication${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""

TOTAL_SUITES=$((TOTAL_SUITES + 1))
if bash "$SCRIPT_DIR/test-keycloak.sh"; then
    PASSED_SUITES=$((PASSED_SUITES + 1))
    echo -e "${GREEN}✓ Keycloak Authentication Tests: PASSED${NC}"
else
    FAILED_SUITES=$((FAILED_SUITES + 1))
    echo -e "${RED}✗ Keycloak Authentication Tests: FAILED${NC}"
fi
echo ""
echo ""

# Test Suite 3: Lakehouse ETL
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}Test Suite 3: Lakehouse ETL Pipeline${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""

TOTAL_SUITES=$((TOTAL_SUITES + 1))
if bash "$SCRIPT_DIR/test-lakehouse-etl.sh"; then
    PASSED_SUITES=$((PASSED_SUITES + 1))
    echo -e "${GREEN}✓ Lakehouse ETL Tests: PASSED${NC}"
else
    FAILED_SUITES=$((FAILED_SUITES + 1))
    echo -e "${RED}✗ Lakehouse ETL Tests: FAILED${NC}"
fi
echo ""
echo ""

# Final Summary
echo "========================================="
echo "Overall Test Summary"
echo "========================================="
echo "Total Test Suites: $TOTAL_SUITES"
echo -e "Passed: ${GREEN}$PASSED_SUITES${NC}"
echo -e "Failed: ${RED}$FAILED_SUITES${NC}"
echo ""

SUCCESS_RATE=$((PASSED_SUITES * 100 / TOTAL_SUITES))
echo "Success Rate: $SUCCESS_RATE%"
echo ""

if [ $FAILED_SUITES -eq 0 ]; then
    echo -e "${GREEN}╔════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  All test suites passed! 🎉       ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════╝${NC}"
    echo ""
    echo "Your deployment is ready for production!"
    exit 0
else
    echo -e "${RED}╔════════════════════════════════════╗${NC}"
    echo -e "${RED}║  Some test suites failed!          ║${NC}"
    echo -e "${RED}╚════════════════════════════════════╝${NC}"
    echo ""
    echo "Please review the failed tests above and fix the issues."
    echo "Refer to the deployment guides in docs/ for troubleshooting."
    exit 1
fi
