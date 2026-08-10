#!/bin/bash

# VPP Platform Environment Validation Script
# Validates all required environment variables and configurations

set -e

echo "========================================="
echo "VPP Platform Environment Validation"
echo "========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

check_var() {
    local var_name=$1
    local var_value="${!var_name}"
    local is_required=${2:-true}
    
    if [ -z "$var_value" ]; then
        if [ "$is_required" = true ]; then
            echo -e "${RED}✗${NC} $var_name: Missing (required)"
            ((ERRORS++))
        else
            echo -e "${YELLOW}⚠${NC} $var_name: Not set (optional)"
            ((WARNINGS++))
        fi
    else
        echo -e "${GREEN}✓${NC} $var_name: Set"
    fi
}

echo "Checking Core Environment Variables:"
echo "-----------------------------------"
check_var "NODE_ENV"
check_var "DATABASE_URL"
check_var "JWT_SECRET"
echo ""

echo "Checking OAuth Configuration:"
echo "----------------------------"
check_var "VITE_APP_ID"
check_var "OAUTH_SERVER_URL"
check_var "VITE_OAUTH_PORTAL_URL"
check_var "OWNER_OPEN_ID"
check_var "OWNER_NAME"
echo ""

echo "Checking Application Configuration:"
echo "----------------------------------"
check_var "VITE_APP_TITLE"
check_var "VITE_APP_LOGO"
echo ""

echo "Checking API Configuration:"
echo "-------------------------"
check_var "BUILT_IN_FORGE_API_URL"
check_var "BUILT_IN_FORGE_API_KEY"
check_var "VITE_FRONTEND_FORGE_API_KEY"
check_var "VITE_FRONTEND_FORGE_API_URL"
echo ""

echo "Checking Analytics Configuration:"
echo "--------------------------------"
check_var "VITE_ANALYTICS_ENDPOINT" false
check_var "VITE_ANALYTICS_WEBSITE_ID" false
echo ""

echo "Checking Payment Gateway Configuration:"
echo "--------------------------------------"
check_var "MPESA_CONSUMER_KEY" false
check_var "MPESA_CONSUMER_SECRET" false
check_var "MPESA_SHORTCODE" false
check_var "MPESA_PASSKEY" false
check_var "AIRTEL_CLIENT_ID" false
check_var "AIRTEL_CLIENT_SECRET" false
check_var "TIGO_API_KEY" false
echo ""

echo "Checking Notification Configuration:"
echo "-----------------------------------"
check_var "SMTP_HOST" false
check_var "SMTP_PORT" false
check_var "SMTP_USER" false
check_var "SMTP_PASS" false
check_var "AFRICAS_TALKING_API_KEY" false
check_var "AFRICAS_TALKING_USERNAME" false
echo ""

echo "Checking MQTT Configuration:"
echo "---------------------------"
check_var "MQTT_BROKER_URL" false
check_var "MQTT_USERNAME" false
check_var "MQTT_PASSWORD" false
echo ""

echo "Checking Fluvio Configuration:"
echo "-----------------------------"
check_var "FLUVIO_CLUSTER_URL" false
check_var "FLUVIO_TOPIC_TELEMETRY" false
echo ""

echo ""
echo "========================================="
echo "Validation Summary"
echo "========================================="
echo -e "Errors: ${RED}$ERRORS${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"
echo ""

if [ $ERRORS -gt 0 ]; then
    echo -e "${RED}Validation failed!${NC} Please fix the errors above."
    exit 1
else
    echo -e "${GREEN}Validation passed!${NC}"
    if [ $WARNINGS -gt 0 ]; then
        echo -e "${YELLOW}Note:${NC} Some optional variables are not set. Features may be limited."
    fi
    exit 0
fi
