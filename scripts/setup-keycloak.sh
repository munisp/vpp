#!/bin/bash

set -e

echo "========================================="
echo "Keycloak VPP Realm Setup"
echo "========================================="
echo ""

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

KEYCLOAK_URL="http://localhost:8080"
ADMIN_USER="admin"
ADMIN_PASSWORD="admin"

echo -e "${YELLOW}Waiting for Keycloak to be ready...${NC}"
for i in {1..30}; do
    if curl -s "$KEYCLOAK_URL/health/ready" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Keycloak is ready${NC}"
        break
    fi
    echo "Waiting... ($i/30)"
    sleep 2
done

echo ""
echo -e "${YELLOW}Getting admin access token...${NC}"
TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$ADMIN_USER" \
  -d "password=$ADMIN_PASSWORD" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | jq -r '.access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" == "null" ]; then
    echo "Failed to get access token"
    exit 1
fi

echo -e "${GREEN}✓ Access token obtained${NC}"
echo ""

echo -e "${YELLOW}Creating VPP realm...${NC}"
curl -s -X POST "$KEYCLOAK_URL/admin/realms" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "realm": "vpp-platform",
    "enabled": true,
    "displayName": "VPP Platform",
    "registrationAllowed": true,
    "loginWithEmailAllowed": true,
    "duplicateEmailsAllowed": false,
    "resetPasswordAllowed": true,
    "editUsernameAllowed": false,
    "bruteForceProtected": true
  }' || echo "Realm may already exist"

echo -e "${GREEN}✓ VPP realm created${NC}"
echo ""

echo -e "${YELLOW}Creating orchestrator client...${NC}"
curl -s -X POST "$KEYCLOAK_URL/admin/realms/vpp-platform/clients" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "vpp-orchestrator",
    "enabled": true,
    "publicClient": false,
    "serviceAccountsEnabled": true,
    "directAccessGrantsEnabled": true,
    "standardFlowEnabled": false,
    "protocol": "openid-connect"
  }' || echo "Client may already exist"

echo -e "${GREEN}✓ Orchestrator client created${NC}"
echo ""

echo -e "${YELLOW}Getting client secret...${NC}"
CLIENT_UUID=$(curl -s "$KEYCLOAK_URL/admin/realms/vpp-platform/clients" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[] | select(.clientId=="vpp-orchestrator") | .id')

if [ -n "$CLIENT_UUID" ]; then
    CLIENT_SECRET=$(curl -s "$KEYCLOAK_URL/admin/realms/vpp-platform/clients/$CLIENT_UUID/client-secret" \
      -H "Authorization: Bearer $TOKEN" | jq -r '.value')
    
    echo -e "${GREEN}✓ Client secret retrieved${NC}"
    echo ""
    echo "Client ID: vpp-orchestrator"
    echo "Client Secret: $CLIENT_SECRET"
    echo ""
    echo "Save this client secret for orchestrator configuration"
fi

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}Keycloak Setup Complete!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo "Keycloak Admin Console: $KEYCLOAK_URL"
echo "Username: admin"
echo "Password: admin"
echo ""
