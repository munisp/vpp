#!/bin/bash

# VPP Platform - Standalone Prometheus Deployment Script
# Version: v22.0
# This script deploys Prometheus without Docker

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "========================================="
echo "VPP Platform - Prometheus Deployment"
echo "========================================="
echo ""

# Configuration
PROMETHEUS_VERSION="${PROMETHEUS_VERSION:-2.47.0}"
INSTALL_DIR="${INSTALL_DIR:-/opt/prometheus}"
DATA_DIR="${DATA_DIR:-/var/lib/prometheus}"
CONFIG_DIR="${CONFIG_DIR:-/etc/prometheus}"

print_status() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ DONE${NC} - $2"
    else
        echo -e "${RED}✗ FAIL${NC} - $2"
    fi
}

print_info() {
    echo -e "${BLUE}ℹ INFO${NC} - $1"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${YELLOW}⚠ WARNING${NC} - This script should be run as root for full functionality"
    echo "Some steps may require manual intervention"
fi

# Step 1: Download Prometheus
echo "Step 1: Downloading Prometheus v$PROMETHEUS_VERSION..."
cd /tmp
wget -q https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz
print_status $? "Prometheus downloaded"
echo ""

# Step 2: Extract and install
echo "Step 2: Installing Prometheus..."
tar xzf prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz
if [ "$EUID" -eq 0 ]; then
    mkdir -p $INSTALL_DIR $DATA_DIR $CONFIG_DIR
    cp prometheus-${PROMETHEUS_VERSION}.linux-amd64/prometheus $INSTALL_DIR/
    cp prometheus-${PROMETHEUS_VERSION}.linux-amd64/promtool $INSTALL_DIR/
    cp -r prometheus-${PROMETHEUS_VERSION}.linux-amd64/consoles $CONFIG_DIR/
    cp -r prometheus-${PROMETHEUS_VERSION}.linux-amd64/console_libraries $CONFIG_DIR/
    print_status $? "Prometheus installed to $INSTALL_DIR"
else
    echo "Skipping installation (requires root)"
fi
echo ""

# Step 3: Copy configuration
echo "Step 3: Copying configuration files..."
if [ "$EUID" -eq 0 ]; then
    cp /home/ubuntu/vpp_consumer_platform/prometheus/prometheus.yml $CONFIG_DIR/
    mkdir -p $CONFIG_DIR/alerts
    cp /home/ubuntu/vpp_consumer_platform/prometheus/alerts/*.yml $CONFIG_DIR/alerts/
    print_status $? "Configuration files copied"
else
    echo "Skipping configuration copy (requires root)"
fi
echo ""

# Step 4: Create systemd service
echo "Step 4: Creating systemd service..."
if [ "$EUID" -eq 0 ]; then
    cat > /etc/systemd/system/prometheus.service << EOF
[Unit]
Description=Prometheus
Documentation=https://prometheus.io/docs/introduction/overview/
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=prometheus
Group=prometheus
ExecReload=/bin/kill -HUP \$MAINPID
ExecStart=$INSTALL_DIR/prometheus \\
  --config.file=$CONFIG_DIR/prometheus.yml \\
  --storage.tsdb.path=$DATA_DIR \\
  --web.console.templates=$CONFIG_DIR/consoles \\
  --web.console.libraries=$CONFIG_DIR/console_libraries \\
  --web.listen-address=0.0.0.0:9090 \\
  --web.enable-lifecycle \\
  --storage.tsdb.retention.time=30d

SyslogIdentifier=prometheus
Restart=always

[Install]
WantedBy=multi-user.target
EOF

    # Create prometheus user
    useradd --no-create-home --shell /bin/false prometheus 2>/dev/null || true
    chown -R prometheus:prometheus $INSTALL_DIR $DATA_DIR $CONFIG_DIR
    
    # Reload systemd and start service
    systemctl daemon-reload
    systemctl enable prometheus
    systemctl start prometheus
    print_status $? "Prometheus service created and started"
else
    echo "Skipping service creation (requires root)"
fi
echo ""

# Step 5: Verify installation
echo "Step 5: Verifying installation..."
sleep 3
if curl -s http://localhost:9090/-/healthy > /dev/null 2>&1; then
    print_status 0 "Prometheus is running and healthy"
else
    echo -e "${YELLOW}⚠ WARNING${NC} - Prometheus health check failed (may need manual start)"
fi
echo ""

# Cleanup
rm -rf /tmp/prometheus-${PROMETHEUS_VERSION}.linux-amd64*

echo "========================================="
echo "Prometheus Deployment Complete"
echo "========================================="
echo ""
echo "Access Prometheus at: http://localhost:9090"
echo ""
echo "Useful commands:"
echo "  systemctl status prometheus   - Check service status"
echo "  systemctl restart prometheus  - Restart service"
echo "  journalctl -u prometheus -f   - View logs"
echo ""
echo "Next steps:"
echo "1. Deploy Grafana: ./scripts/deploy-grafana.sh"
echo "2. Deploy Alertmanager: ./scripts/deploy-alertmanager.sh"
echo "3. Deploy exporters: ./scripts/deploy-exporters.sh"
echo ""
echo "========================================="
