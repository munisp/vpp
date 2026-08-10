#!/bin/bash

# VPP Platform - Security Configuration Verification Script
# Version: v22.0
# This script verifies security configurations without requiring root access

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "========================================="
echo "VPP Platform Security Verification"
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

# Test 1: Check if security scripts exist
echo "Test 1: Security Scripts"
if [ -f "scripts/security-hardening.sh" ] && [ -x "scripts/security-hardening.sh" ]; then
    print_pass "Security hardening script exists and is executable"
else
    print_fail "Security hardening script missing or not executable"
fi

if [ -f "scripts/setup-secrets-manager.sh" ] && [ -x "scripts/setup-secrets-manager.sh" ]; then
    print_pass "Secrets management script exists and is executable"
else
    print_fail "Secrets management script missing or not executable"
fi
echo ""

# Test 2: Check .env file security
echo "Test 2: Environment File Security"
if [ -f ".env" ]; then
    perms=$(stat -c "%a" .env 2>/dev/null || stat -f "%A" .env 2>/dev/null || echo "unknown")
    if [ "$perms" = "600" ] || [ "$perms" = "400" ]; then
        print_pass ".env file has secure permissions ($perms)"
    else
        print_warn ".env file permissions are $perms (recommended: 600)"
    fi
else
    print_warn ".env file not found"
fi
echo ""

# Test 3: Check for sensitive files in git
echo "Test 3: Git Security"
if [ -f ".gitignore" ]; then
    if grep -q "\.env" .gitignore && grep -q "\.env\.\*" .gitignore; then
        print_pass ".env files are in .gitignore"
    else
        print_fail ".env files not properly excluded from git"
    fi
else
    print_warn ".gitignore file not found"
fi
echo ""

# Test 4: Check SSL/TLS configuration files
echo "Test 4: SSL/TLS Configuration"
if [ -f "prometheus/prometheus.yml" ]; then
    if grep -q "scheme: https" prometheus/prometheus.yml 2>/dev/null; then
        print_pass "Prometheus configured for HTTPS"
    else
        print_warn "Prometheus not configured for HTTPS (development mode)"
    fi
else
    print_warn "Prometheus configuration not found"
fi
echo ""

# Test 5: Check firewall configuration
echo "Test 5: Firewall Configuration"
if command -v ufw &> /dev/null; then
    if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
        print_pass "UFW firewall is active"
    else
        print_warn "UFW firewall is not active"
    fi
else
    print_warn "UFW firewall not installed"
fi
echo ""

# Test 6: Check Fail2Ban configuration
echo "Test 6: Brute Force Protection"
if command -v fail2ban-client &> /dev/null; then
    if sudo systemctl is-active fail2ban &> /dev/null; then
        print_pass "Fail2Ban is running"
    else
        print_warn "Fail2Ban is not running"
    fi
else
    print_warn "Fail2Ban not installed"
fi
echo ""

# Test 7: Check Nginx configuration
echo "Test 7: Reverse Proxy Configuration"
if command -v nginx &> /dev/null; then
    if [ -f "/etc/nginx/sites-available/vpp-platform" ]; then
        if grep -q "ssl_certificate" /etc/nginx/sites-available/vpp-platform 2>/dev/null; then
            print_pass "Nginx configured with SSL"
        else
            print_warn "Nginx not configured with SSL"
        fi
    else
        print_warn "Nginx VPP configuration not found"
    fi
else
    print_warn "Nginx not installed"
fi
echo ""

# Test 8: Check secrets management
echo "Test 8: Secrets Management"
if command -v aws &> /dev/null; then
    print_info "AWS CLI installed (AWS Secrets Manager available)"
elif command -v vault &> /dev/null; then
    print_info "Vault CLI installed (HashiCorp Vault available)"
elif command -v dotenv-vault &> /dev/null; then
    print_info "dotenv-vault installed (Encrypted .env available)"
else
    print_warn "No secrets management solution installed"
fi
echo ""

# Test 9: Check audit logging
echo "Test 9: Audit Logging"
if command -v auditd &> /dev/null; then
    if sudo systemctl is-active auditd &> /dev/null; then
        print_pass "Audit daemon is running"
    else
        print_warn "Audit daemon is not running"
    fi
else
    print_warn "Audit daemon not installed"
fi
echo ""

# Test 10: Check security headers in application
echo "Test 10: Application Security Headers"
if [ -f "server/_core/index.ts" ]; then
    if grep -q "helmet" server/_core/index.ts 2>/dev/null; then
        print_pass "Security headers middleware (helmet) configured"
    else
        print_warn "Security headers middleware not found"
    fi
else
    print_warn "Application server file not found"
fi
echo ""

# Test 11: Check rate limiting
echo "Test 11: Rate Limiting"
if [ -f "server/_core/index.ts" ]; then
    if grep -q "rateLimit" server/_core/index.ts 2>/dev/null; then
        print_pass "Rate limiting configured in application"
    else
        print_warn "Rate limiting not found in application"
    fi
fi
echo ""

# Test 12: Check CORS configuration
echo "Test 12: CORS Configuration"
if [ -f "server/_core/index.ts" ]; then
    if grep -q "cors" server/_core/index.ts 2>/dev/null; then
        print_pass "CORS configured in application"
    else
        print_warn "CORS not found in application"
    fi
fi
echo ""

# Test 13: Check SSL certificate expiry
echo "Test 13: SSL Certificate Status"
if [ -d "/etc/letsencrypt/live" ]; then
    cert_file=$(find /etc/letsencrypt/live -name "cert.pem" 2>/dev/null | head -1)
    if [ -n "$cert_file" ]; then
        expiry=$(sudo openssl x509 -enddate -noout -in "$cert_file" 2>/dev/null | cut -d= -f2)
        if [ -n "$expiry" ]; then
            print_info "SSL certificate expires: $expiry"
        fi
    else
        print_warn "No Let's Encrypt certificate found"
    fi
else
    print_warn "Let's Encrypt directory not found"
fi
echo ""

# Test 14: Check password complexity in Keycloak config
echo "Test 14: Password Policies"
if [ -f "server/integration/keycloak-client.ts" ]; then
    print_info "Keycloak client implementation found"
    print_info "Password policies should be configured in Keycloak admin console"
else
    print_warn "Keycloak client implementation not found"
fi
echo ""

# Test 15: Check for hardcoded secrets
echo "Test 15: Hardcoded Secrets Check"
if command -v grep &> /dev/null; then
    hardcoded_count=$(grep -r -i "password\s*=\s*['\"]" server/ client/ 2>/dev/null | grep -v "node_modules" | wc -l || echo "0")
    if [ "$hardcoded_count" -eq 0 ]; then
        print_pass "No obvious hardcoded passwords found"
    else
        print_fail "Found $hardcoded_count potential hardcoded passwords"
    fi
fi
echo ""

# Summary
echo "========================================="
echo "Security Verification Summary"
echo "========================================="
echo -e "${GREEN}Passed:${NC} $PASS_COUNT"
echo -e "${YELLOW}Warnings:${NC} $WARN_COUNT"
echo -e "${RED}Failed:${NC} $FAIL_COUNT"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}✓ Security configuration looks good!${NC}"
    echo ""
    echo "Recommendations:"
    echo "1. Run security hardening script: sudo ./scripts/security-hardening.sh"
    echo "2. Set up secrets management: ./scripts/setup-secrets-manager.sh"
    echo "3. Configure Keycloak security settings (see docs/KEYCLOAK_SETUP_GUIDE.md)"
    echo "4. Review and test all security configurations"
    exit 0
else
    echo -e "${RED}✗ Security issues detected!${NC}"
    echo ""
    echo "Please address the failed checks above before deploying to production."
    exit 1
fi
