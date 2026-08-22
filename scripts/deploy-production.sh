#!/bin/bash

# VPP Platform Production Deployment Script
# This script automates the deployment of the VPP platform to production

set -e  # Exit on error

echo "========================================="
echo "VPP Platform Production Deployment"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DEPLOY_DIR="${DEPLOY_DIR:-/opt/vpp-platform}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vpp-platform}"
LOG_DIR="${LOG_DIR:-/var/log/vpp-platform}"

# Functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if running as root or with sudo
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root or with sudo"
        exit 1
    fi
    
    # Check required commands
    local required_commands=("docker" "docker-compose" "node" "npm" "psql")
    for cmd in "${required_commands[@]}"; do
        if ! command -v $cmd &> /dev/null; then
            log_error "$cmd is not installed"
            exit 1
        fi
    done
    
    log_info "All prerequisites met"
}

validate_environment() {
    log_info "Validating environment variables..."
    
    # Required environment variables
    local required_vars=(
        "DATABASE_URL"
        "JWT_SECRET"
        "VITE_APP_ID"
        "OAUTH_SERVER_URL"
    )
    
    local missing_vars=()
    for var in "${required_vars[@]}"; do
        if [ -z "${!var}" ]; then
            missing_vars+=("$var")
        fi
    done
    
    if [ ${#missing_vars[@]} -gt 0 ]; then
        log_error "Missing required environment variables:"
        for var in "${missing_vars[@]}"; do
            echo "  - $var"
        done
        exit 1
    fi
    
    log_info "Environment validation passed"
}

create_directories() {
    log_info "Creating deployment directories..."
    
    mkdir -p "$DEPLOY_DIR"
    mkdir -p "$BACKUP_DIR"
    mkdir -p "$LOG_DIR"
    mkdir -p "$DEPLOY_DIR/data/mosquitto"
    mkdir -p "$DEPLOY_DIR/data/fluvio"
    mkdir -p "$DEPLOY_DIR/data/prometheus"
    mkdir -p "$DEPLOY_DIR/data/grafana"
    
    log_info "Directories created"
}

backup_existing() {
    if [ -d "$DEPLOY_DIR/app" ]; then
        log_info "Creating backup of existing deployment..."
        
        local backup_name="vpp-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
        tar -czf "$BACKUP_DIR/$backup_name" -C "$DEPLOY_DIR" app
        
        log_info "Backup created: $backup_name"
    fi
}

deploy_application() {
    log_info "Deploying application..."
    
    # Copy application files
    cp -r . "$DEPLOY_DIR/app"
    cd "$DEPLOY_DIR/app"
    
    # Install dependencies
    log_info "Installing dependencies..."
    npm install --production
    
    # Build application
    log_info "Building application..."
    npm run build
    
    log_info "Application deployed"
}

setup_database() {
    log_info "Setting up database..."
    
    # Apply committed migrations — never use `drizzle-kit push` in production:
    # push diffs the schema against the live database and can apply destructive
    # changes without a migration history or review.
    cd "$DEPLOY_DIR/app"
    if [ ! -d "drizzle" ] || ! ls drizzle/*.sql >/dev/null 2>&1; then
        log_error "Migrations directory 'drizzle/' is missing or contains no .sql migrations."
        log_error "Generate migrations with 'pnpm drizzle-kit generate' and commit them before deploying."
        exit 1
    fi
    npx drizzle-kit migrate
    
    log_info "Database setup complete"
}

deploy_services() {
    log_info "Deploying backend services..."
    
    cd "$DEPLOY_DIR/app/services"
    
    # Build Docker images
    log_info "Building Docker images..."
    docker-compose build
    
    # Start services
    log_info "Starting services..."
    docker-compose up -d
    
    log_info "Services deployed"
}

configure_nginx() {
    log_info "Configuring Nginx..."
    
    cat > /etc/nginx/sites-available/vpp-platform << 'EOF'
server {
    listen 80;
    server_name _;
    
    # Redirect to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name _;
    
    # SSL configuration
    ssl_certificate /etc/ssl/certs/vpp-platform.crt;
    ssl_certificate_key /etc/ssl/private/vpp-platform.key;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    
    # Application
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # WebSocket
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # Grafana
    location /grafana/ {
        proxy_pass http://localhost:3001/;
        proxy_set_header Host $host;
    }
    
    # Prometheus
    location /prometheus/ {
        proxy_pass http://localhost:9090/;
        proxy_set_header Host $host;
    }
}
EOF
    
    # Enable site
    ln -sf /etc/nginx/sites-available/vpp-platform /etc/nginx/sites-enabled/
    
    # Test configuration
    nginx -t
    
    # Reload Nginx
    systemctl reload nginx
    
    log_info "Nginx configured"
}

setup_systemd() {
    log_info "Setting up systemd services..."
    
    # VPP Application Service
    cat > /etc/systemd/system/vpp-platform.service << EOF
[Unit]
Description=VPP Platform Application
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=$DEPLOY_DIR/app
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/_core/index.js
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/app.log
StandardError=append:$LOG_DIR/app-error.log

[Install]
WantedBy=multi-user.target
EOF
    
    # Reload systemd
    systemctl daemon-reload
    
    # Enable and start service
    systemctl enable vpp-platform
    systemctl start vpp-platform
    
    log_info "Systemd services configured"
}

verify_deployment() {
    log_info "Verifying deployment..."
    
    # Check if application is running
    sleep 5
    
    if curl -f http://localhost:3000 > /dev/null 2>&1; then
        log_info "✓ Application is running"
    else
        log_error "✗ Application is not responding"
        return 1
    fi
    
    # Check database connection
    if psql -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" -d "${DB_NAME:-vpp_platform}" -tAc "SELECT 1" > /dev/null 2>&1; then
        log_info "✓ Database is accessible"
    else
        log_warn "✗ Database connection failed"
    fi
    
    # Check Docker services
    if docker-compose -f "$DEPLOY_DIR/app/services/docker-compose.yml" ps | grep -q "Up"; then
        log_info "✓ Docker services are running"
    else
        log_warn "✗ Some Docker services are not running"
    fi
    
    log_info "Deployment verification complete"
}

show_summary() {
    echo ""
    echo "========================================="
    echo "Deployment Summary"
    echo "========================================="
    echo ""
    echo "Application URL: https://$(hostname -f)"
    echo "Grafana URL: https://$(hostname -f)/grafana"
    echo "Prometheus URL: https://$(hostname -f)/prometheus"
    echo ""
    echo "Logs:"
    echo "  Application: $LOG_DIR/app.log"
    echo "  Services: docker-compose logs in $DEPLOY_DIR/app/services"
    echo ""
    echo "Useful commands:"
    echo "  Status: systemctl status vpp-platform"
    echo "  Logs: journalctl -u vpp-platform -f"
    echo "  Services: docker-compose -f $DEPLOY_DIR/app/services/docker-compose.yml ps"
    echo ""
}

# Main deployment flow
main() {
    check_prerequisites
    validate_environment
    create_directories
    backup_existing
    deploy_application
    setup_database
    deploy_services
    configure_nginx
    setup_systemd
    verify_deployment
    show_summary
    
    log_info "Deployment complete!"
}

# Run main function
main
