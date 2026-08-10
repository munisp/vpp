#!/bin/bash

# Keycloak Authentication Test Script
# Tests all aspects of Keycloak integration

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

# Configuration
KEYCLOAK_URL=${KEYCLOAK_SERVER_URL:-http://localhost:8080}
KEYCLOAK_REALM=${KEYCLOAK_REALM:-vpp-platform}
KEYCLOAK_CLIENT_ID=${KEYCLOAK_CLIENT_ID:-vpp-consumer-platform}

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
echo "Keycloak Authentication Tests"
echo "========================================="
echo ""

# Test 1: Keycloak server connectivity
echo "Test 1: Keycloak Server Connectivity"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$KEYCLOAK_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "303" ]; then
    print_result "Keycloak Server Connection" "PASS" "HTTP $HTTP_CODE from $KEYCLOAK_URL"
else
    print_result "Keycloak Server Connection" "FAIL" "HTTP $HTTP_CODE from $KEYCLOAK_URL"
fi
echo ""

# Test 2: Realm endpoint
echo "Test 2: Realm Endpoint"
REALM_URL="$KEYCLOAK_URL/realms/$KEYCLOAK_REALM"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$REALM_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    print_result "Realm Endpoint" "PASS" "Realm '$KEYCLOAK_REALM' accessible"
else
    print_result "Realm Endpoint" "FAIL" "Realm not found (HTTP $HTTP_CODE)"
fi
echo ""

# Test 3: OpenID Connect configuration
echo "Test 3: OpenID Connect Configuration"
OIDC_URL="$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/.well-known/openid-configuration"
OIDC_RESPONSE=$(curl -s "$OIDC_URL" 2>/dev/null)
if echo "$OIDC_RESPONSE" | grep -q "token_endpoint"; then
    print_result "OIDC Configuration" "PASS" "OpenID Connect endpoints available"
else
    print_result "OIDC Configuration" "FAIL" "OIDC configuration not available"
fi
echo ""

# Test 4: Keycloak client implementation
echo "Test 4: Keycloak Client Implementation"
if [ -f "$PROJECT_DIR/server/integration/keycloak-client.ts" ]; then
    if grep -q "authenticateUser" "$PROJECT_DIR/server/integration/keycloak-client.ts" && \
       grep -q "validateToken" "$PROJECT_DIR/server/integration/keycloak-client.ts"; then
        print_result "Keycloak Client File" "PASS" "Client implementation found"
    else
        print_result "Keycloak Client File" "FAIL" "Client methods incomplete"
    fi
else
    print_result "Keycloak Client File" "FAIL" "keycloak-client.ts not found"
fi
echo ""

# Test 5: Environment variables
echo "Test 5: Environment Variables"
ENV_VARS_OK=true
if [ -z "$KEYCLOAK_SERVER_URL" ]; then
    echo -e "${YELLOW}  ⚠ KEYCLOAK_SERVER_URL not set (using default)${NC}"
fi
if [ -z "$KEYCLOAK_CLIENT_SECRET" ]; then
    echo -e "${YELLOW}  ⚠ KEYCLOAK_CLIENT_SECRET not set${NC}"
    ENV_VARS_OK=false
fi

if [ "$ENV_VARS_OK" = true ]; then
    print_result "Environment Variables" "PASS" "All required variables configured"
else
    print_result "Environment Variables" "FAIL" "Missing KEYCLOAK_CLIENT_SECRET"
fi
echo ""

# Test 6: Token endpoint
echo "Test 6: Token Endpoint"
TOKEN_URL="$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$TOKEN_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "401" ]; then
    # 400/401 means endpoint exists but requires auth
    print_result "Token Endpoint" "PASS" "Token endpoint accessible"
else
    print_result "Token Endpoint" "FAIL" "Token endpoint not accessible (HTTP $HTTP_CODE)"
fi
echo ""

# Test 7: User authentication (if credentials provided)
echo "Test 7: User Authentication"
if [ -n "$KEYCLOAK_CLIENT_SECRET" ] && [ -n "$TEST_USERNAME" ] && [ -n "$TEST_PASSWORD" ]; then
    TOKEN_RESPONSE=$(curl -s -X POST "$TOKEN_URL" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "grant_type=password" \
        -d "client_id=$KEYCLOAK_CLIENT_ID" \
        -d "client_secret=$KEYCLOAK_CLIENT_SECRET" \
        -d "username=$TEST_USERNAME" \
        -d "password=$TEST_PASSWORD" 2>/dev/null)
    
    if echo "$TOKEN_RESPONSE" | grep -q "access_token"; then
        print_result "User Authentication" "PASS" "Successfully authenticated user"
        ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
    else
        print_result "User Authentication" "FAIL" "Authentication failed"
    fi
else
    echo -e "${YELLOW}⊘ SKIP${NC} - User Authentication: Set TEST_USERNAME and TEST_PASSWORD to test"
fi
echo ""

# Test 8: Token validation (if token obtained)
echo "Test 8: Token Validation"
if [ -n "$ACCESS_TOKEN" ]; then
    INTROSPECT_URL="$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token/introspect"
    INTROSPECT_RESPONSE=$(curl -s -X POST "$INTROSPECT_URL" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "client_id=$KEYCLOAK_CLIENT_ID" \
        -d "client_secret=$KEYCLOAK_CLIENT_SECRET" \
        -d "token=$ACCESS_TOKEN" 2>/dev/null)
    
    if echo "$INTROSPECT_RESPONSE" | grep -q '"active":true'; then
        print_result "Token Validation" "PASS" "Token is valid"
    else
        print_result "Token Validation" "FAIL" "Token validation failed"
    fi
else
    echo -e "${YELLOW}⊘ SKIP${NC} - Token Validation: No token available"
fi
echo ""

# Test 9: User info endpoint (if token obtained)
echo "Test 9: User Info Endpoint"
if [ -n "$ACCESS_TOKEN" ]; then
    USERINFO_URL="$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/userinfo"
    USERINFO_RESPONSE=$(curl -s "$USERINFO_URL" \
        -H "Authorization: Bearer $ACCESS_TOKEN" 2>/dev/null)
    
    if echo "$USERINFO_RESPONSE" | grep -q "sub"; then
        print_result "User Info Endpoint" "PASS" "User info retrieved"
    else
        print_result "User Info Endpoint" "FAIL" "Failed to retrieve user info"
    fi
else
    echo -e "${YELLOW}⊘ SKIP${NC} - User Info Endpoint: No token available"
fi
echo ""

# Test 10: Keycloak setup guide
echo "Test 10: Keycloak Setup Guide"
if [ -f "$PROJECT_DIR/docs/KEYCLOAK_SETUP_GUIDE.md" ]; then
    print_result "Setup Guide Documentation" "PASS" "Documentation available"
else
    print_result "Setup Guide Documentation" "FAIL" "Setup guide not found"
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
    echo "1. Set KEYCLOAK_CLIENT_SECRET environment variable"
    echo "2. Create test user in Keycloak admin console"
    echo "3. Run with TEST_USERNAME and TEST_PASSWORD to test authentication"
    exit 0
else
    echo -e "${RED}Some tests failed. Please review the output above.${NC}"
    exit 1
fi
