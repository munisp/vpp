#!/bin/bash

# MQTT Broker Deployment Script
# VPP Consumer Platform

set -e

echo "========================================="
echo "VPP MQTT Broker Deployment"
echo "========================================="

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}Please run as root (use sudo)${NC}"
  exit 1
fi

# =============================================================================
# 1. Install Mosquitto
# =============================================================================

echo -e "\n${YELLOW}[1/7] Installing Mosquitto MQTT Broker...${NC}"

if ! command -v mosquitto &> /dev/null; then
  apt-get update
  apt-get install -y mosquitto mosquitto-clients
  echo -e "${GREEN}✓ Mosquitto installed${NC}"
else
  echo -e "${GREEN}✓ Mosquitto already installed${NC}"
fi

# =============================================================================
# 2. Create Directory Structure
# =============================================================================

echo -e "\n${YELLOW}[2/7] Creating directory structure...${NC}"

mkdir -p /etc/mosquitto/certs
mkdir -p /var/lib/mosquitto
mkdir -p /var/log/mosquitto

chown -R mosquitto:mosquitto /var/lib/mosquitto
chown -R mosquitto:mosquitto /var/log/mosquitto

echo -e "${GREEN}✓ Directories created${NC}"

# =============================================================================
# 3. Generate SSL Certificates
# =============================================================================

echo -e "\n${YELLOW}[3/7] Generating SSL certificates...${NC}"

if [ ! -f /etc/mosquitto/certs/ca.crt ]; then
  # Generate CA private key
  openssl genrsa -out /etc/mosquitto/certs/ca.key 4096
  
  # Generate CA certificate
  openssl req -new -x509 -days 3650 -key /etc/mosquitto/certs/ca.key \
    -out /etc/mosquitto/certs/ca.crt \
    -subj "/C=TZ/ST=Dar es Salaam/L=Dar es Salaam/O=VPP Platform/OU=IoT/CN=VPP CA"
  
  # Generate server private key
  openssl genrsa -out /etc/mosquitto/certs/server.key 4096
  
  # Generate server certificate signing request
  openssl req -new -key /etc/mosquitto/certs/server.key \
    -out /etc/mosquitto/certs/server.csr \
    -subj "/C=TZ/ST=Dar es Salaam/L=Dar es Salaam/O=VPP Platform/OU=IoT/CN=mqtt.vpp.local"
  
  # Sign server certificate with CA
  openssl x509 -req -in /etc/mosquitto/certs/server.csr \
    -CA /etc/mosquitto/certs/ca.crt \
    -CAkey /etc/mosquitto/certs/ca.key \
    -CAcreateserial \
    -out /etc/mosquitto/certs/server.crt \
    -days 3650
  
  # Set permissions
  chmod 644 /etc/mosquitto/certs/*.crt
  chmod 600 /etc/mosquitto/certs/*.key
  chown mosquitto:mosquitto /etc/mosquitto/certs/*
  
  echo -e "${GREEN}✓ SSL certificates generated${NC}"
else
  echo -e "${GREEN}✓ SSL certificates already exist${NC}"
fi

# =============================================================================
# 4. Create Admin User
# =============================================================================

echo -e "\n${YELLOW}[4/7] Creating admin user...${NC}"

# Generate random password if not provided
ADMIN_PASSWORD=${MQTT_ADMIN_PASSWORD:-$(openssl rand -base64 32)}

# Create password file
mosquitto_passwd -c -b /etc/mosquitto/passwd vpp-admin "$ADMIN_PASSWORD"

# Create server user
SERVER_PASSWORD=${MQTT_SERVER_PASSWORD:-$(openssl rand -base64 32)}
mosquitto_passwd -b /etc/mosquitto/passwd vpp-server "$SERVER_PASSWORD"

chmod 600 /etc/mosquitto/passwd
chown mosquitto:mosquitto /etc/mosquitto/passwd

echo -e "${GREEN}✓ Admin user created${NC}"
echo -e "${YELLOW}Admin credentials:${NC}"
echo -e "  Username: vpp-admin"
echo -e "  Password: $ADMIN_PASSWORD"
echo -e "${YELLOW}Server credentials:${NC}"
echo -e "  Username: vpp-server"
echo -e "  Password: $SERVER_PASSWORD"
echo ""
echo -e "${RED}IMPORTANT: Save these credentials securely!${NC}"

# =============================================================================
# 5. Copy Configuration Files
# =============================================================================

echo -e "\n${YELLOW}[5/7] Copying configuration files...${NC}"

cp mosquitto.conf /etc/mosquitto/mosquitto.conf
cp acl /etc/mosquitto/acl

chmod 644 /etc/mosquitto/mosquitto.conf
chmod 644 /etc/mosquitto/acl
chown mosquitto:mosquitto /etc/mosquitto/mosquitto.conf
chown mosquitto:mosquitto /etc/mosquitto/acl

echo -e "${GREEN}✓ Configuration files copied${NC}"

# =============================================================================
# 6. Configure Firewall
# =============================================================================

echo -e "\n${YELLOW}[6/7] Configuring firewall...${NC}"

if command -v ufw &> /dev/null; then
  ufw allow 1883/tcp comment 'MQTT'
  ufw allow 8883/tcp comment 'MQTTS'
  ufw allow 8884/tcp comment 'MQTT WebSockets'
  echo -e "${GREEN}✓ Firewall configured${NC}"
else
  echo -e "${YELLOW}⚠ UFW not found, skipping firewall configuration${NC}"
fi

# =============================================================================
# 7. Start Mosquitto Service
# =============================================================================

echo -e "\n${YELLOW}[7/7] Starting Mosquitto service...${NC}"

systemctl enable mosquitto
systemctl restart mosquitto

# Wait for service to start
sleep 2

if systemctl is-active --quiet mosquitto; then
  echo -e "${GREEN}✓ Mosquitto service started${NC}"
else
  echo -e "${RED}✗ Failed to start Mosquitto service${NC}"
  systemctl status mosquitto
  exit 1
fi

# =============================================================================
# Deployment Complete
# =============================================================================

echo -e "\n${GREEN}=========================================${NC}"
echo -e "${GREEN}MQTT Broker Deployment Complete!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo -e "Broker Status: ${GREEN}RUNNING${NC}"
echo -e "MQTT Port: 1883 (plain)"
echo -e "MQTTS Port: 8883 (SSL/TLS)"
echo -e "WebSocket Port: 8884 (WSS)"
echo ""
echo -e "Configuration: /etc/mosquitto/mosquitto.conf"
echo -e "Logs: /var/log/mosquitto/mosquitto.log"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo -e "1. Update .env with MQTT credentials:"
echo -e "   MQTT_BROKER_URL=mqtts://your-server:8883"
echo -e "   MQTT_USERNAME=vpp-server"
echo -e "   MQTT_PASSWORD=$SERVER_PASSWORD"
echo ""
echo -e "2. Test connection:"
echo -e "   mosquitto_sub -h localhost -p 8883 --cafile /etc/mosquitto/certs/ca.crt \\"
echo -e "     -u vpp-admin -P '$ADMIN_PASSWORD' -t 'vpp/#' -v"
echo ""
echo -e "3. Restart your application to connect to MQTT broker"
echo ""
