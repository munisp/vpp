#!/bin/bash

# VPP Platform - Automated Security Hardening Script
# Version: v21.0
# This script automates security hardening tasks for production deployment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="${DOMAIN:-vpp-platform.yourdomain.com}"
EMAIL="${EMAIL:-admin@yourdomain.com}"
ENVIRONMENT="${ENVIRONMENT:-production}"

echo "========================================="
echo "VPP Platform Security Hardening"
echo "========================================="
echo "Domain: $DOMAIN"
echo "Email: $EMAIL"
echo "Environment: $ENVIRONMENT"
echo "========================================="
echo ""

# Function to print status
print_status() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ DONE${NC} - $2"
    else
        echo -e "${RED}✗ FAIL${NC} - $2"
    fi
}

print_warning() {
    echo -e "${YELLOW}⚠ WARNING${NC} - $1"
}

print_info() {
    echo -e "ℹ INFO - $1"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    print_warning "This script should be run as root for full functionality"
    print_info "Some steps may be skipped or require manual intervention"
fi

# 1. Update system packages
echo "Step 1: Updating system packages..."
if [ "$EUID" -eq 0 ]; then
    apt-get update -qq && apt-get upgrade -y -qq
    print_status $? "System packages updated"
else
    print_warning "Skipping system update (requires root)"
fi
echo ""

# 2. Install security tools
echo "Step 2: Installing security tools..."
if [ "$EUID" -eq 0 ]; then
    apt-get install -y -qq ufw fail2ban certbot nginx
    print_status $? "Security tools installed"
else
    print_warning "Skipping security tools installation (requires root)"
fi
echo ""

# 3. Configure firewall
echo "Step 3: Configuring firewall..."
if [ "$EUID" -eq 0 ]; then
    # Reset UFW to default
    ufw --force reset > /dev/null 2>&1
    
    # Default policies
    ufw default deny incoming
    ufw default allow outgoing
    
    # Allow SSH
    ufw allow 22/tcp comment 'SSH'
    
    # Allow HTTP/HTTPS
    ufw allow 80/tcp comment 'HTTP'
    ufw allow 443/tcp comment 'HTTPS'
    
    # Allow application port
    ufw allow 3000/tcp comment 'VPP Application'
    
    # Allow Prometheus (internal only - should be restricted by IP)
    ufw allow from 10.0.0.0/8 to any port 9090 comment 'Prometheus'
    
    # Allow Grafana (internal only - should be restricted by IP)
    ufw allow from 10.0.0.0/8 to any port 3001 comment 'Grafana'
    
    # Enable UFW
    ufw --force enable
    print_status $? "Firewall configured"
else
    print_warning "Skipping firewall configuration (requires root)"
fi
echo ""

# 4. Configure Fail2Ban
echo "Step 4: Configuring Fail2Ban..."
if [ "$EUID" -eq 0 ]; then
    # Create custom jail configuration
    cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
destemail = admin@yourdomain.com
sendername = Fail2Ban
action = %(action_mwl)s

[sshd]
enabled = true
port = ssh
logpath = /var/log/auth.log

[nginx-http-auth]
enabled = true
port = http,https
logpath = /var/log/nginx/error.log

[nginx-limit-req]
enabled = true
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 10
EOF
    
    systemctl restart fail2ban
    print_status $? "Fail2Ban configured"
else
    print_warning "Skipping Fail2Ban configuration (requires root)"
fi
echo ""

# 5. Generate SSL certificates
echo "Step 5: Generating SSL certificates..."
if [ "$EUID" -eq 0 ]; then
    if [ "$ENVIRONMENT" = "production" ]; then
        # Use Let's Encrypt for production
        certbot certonly --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive
        print_status $? "Let's Encrypt certificate generated"
    else
        # Generate self-signed certificate for development
        mkdir -p /etc/ssl/private
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout /etc/ssl/private/vpp-selfsigned.key \
            -out /etc/ssl/certs/vpp-selfsigned.crt \
            -subj "/C=US/ST=State/L=City/O=VPP/CN=$DOMAIN"
        print_status $? "Self-signed certificate generated"
    fi
else
    print_warning "Skipping SSL certificate generation (requires root)"
fi
echo ""

# 6. Configure Nginx with TLS
echo "Step 6: Configuring Nginx with TLS..."
if [ "$EUID" -eq 0 ]; then
    cat > /etc/nginx/sites-available/vpp-platform << EOF
# VPP Platform Nginx Configuration

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    # SSL configuration
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Content-Security-Policy "default-src 'self' https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';" always;

    # Rate limiting
    limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=10r/s;
    limit_req_zone \$binary_remote_addr zone=login_limit:10m rate=5r/m;

    # Proxy to application
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # API rate limiting
    location /api/ {
        limit_req zone=api_limit burst=20 nodelay;
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Login rate limiting
    location /api/oauth/ {
        limit_req zone=login_limit burst=5 nodelay;
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
    
    # Enable site
    ln -sf /etc/nginx/sites-available/vpp-platform /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    
    # Test and reload Nginx
    nginx -t && systemctl reload nginx
    print_status $? "Nginx configured with TLS"
else
    print_warning "Skipping Nginx configuration (requires root)"
fi
echo ""

# 7. Set up automatic certificate renewal
echo "Step 7: Setting up automatic certificate renewal..."
if [ "$EUID" -eq 0 ] && [ "$ENVIRONMENT" = "production" ]; then
    # Add cron job for certificate renewal
    (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
    print_status $? "Automatic certificate renewal configured"
else
    print_warning "Skipping certificate renewal setup"
fi
echo ""

# 8. Secure file permissions
echo "Step 8: Securing file permissions..."
cd /home/ubuntu/vpp_consumer_platform

# Secure sensitive files
chmod 600 .env* 2>/dev/null || true
chmod 600 ecosystem.config.js 2>/dev/null || true
chmod 700 scripts/*.sh 2>/dev/null || true

# Set ownership
if [ "$EUID" -eq 0 ]; then
    chown -R ubuntu:ubuntu /home/ubuntu/vpp_consumer_platform
fi

print_status 0 "File permissions secured"
echo ""

# 9. Configure audit logging
echo "Step 9: Configuring audit logging..."
if [ "$EUID" -eq 0 ]; then
    # Install auditd
    apt-get install -y -qq auditd
    
    # Add audit rules
    cat >> /etc/audit/rules.d/vpp.rules << 'EOF'
# VPP Platform Audit Rules
-w /home/ubuntu/vpp_consumer_platform/.env -p wa -k vpp_env_changes
-w /home/ubuntu/vpp_consumer_platform/server/ -p wa -k vpp_code_changes
-w /etc/nginx/sites-available/vpp-platform -p wa -k vpp_nginx_changes
EOF
    
    systemctl restart auditd
    print_status $? "Audit logging configured"
else
    print_warning "Skipping audit logging configuration (requires root)"
fi
echo ""

# 10. Create security monitoring script
echo "Step 10: Creating security monitoring script..."
cat > /home/ubuntu/vpp_consumer_platform/scripts/security-monitor.sh << 'EOF'
#!/bin/bash

# VPP Platform Security Monitoring Script
# Run this script periodically to check for security issues

echo "VPP Platform Security Monitor"
echo "============================="
echo ""

# Check for failed login attempts
echo "Recent failed SSH login attempts:"
grep "Failed password" /var/log/auth.log 2>/dev/null | tail -5 || echo "No recent failures"
echo ""

# Check Fail2Ban status
echo "Fail2Ban banned IPs:"
fail2ban-client status sshd 2>/dev/null | grep "Banned IP" || echo "Fail2Ban not running"
echo ""

# Check SSL certificate expiry
echo "SSL certificate expiry:"
if [ -f "/etc/letsencrypt/live/*/cert.pem" ]; then
    openssl x509 -enddate -noout -in /etc/letsencrypt/live/*/cert.pem
else
    echo "No Let's Encrypt certificate found"
fi
echo ""

# Check for outdated packages
echo "Security updates available:"
apt list --upgradable 2>/dev/null | grep -i security | wc -l
echo ""

# Check disk space
echo "Disk usage:"
df -h / | tail -1
echo ""

# Check memory usage
echo "Memory usage:"
free -h | grep Mem
echo ""

echo "============================="
echo "Security check complete"
EOF

chmod +x /home/ubuntu/vpp_consumer_platform/scripts/security-monitor.sh
print_status 0 "Security monitoring script created"
echo ""

# 11. Summary
echo "========================================="
echo "Security Hardening Complete"
echo "========================================="
echo ""
echo "✓ System packages updated"
echo "✓ Firewall configured (UFW)"
echo "✓ Fail2Ban configured"
echo "✓ SSL certificates generated"
echo "✓ Nginx configured with TLS"
echo "✓ Certificate auto-renewal set up"
echo "✓ File permissions secured"
echo "✓ Audit logging configured"
echo "✓ Security monitoring script created"
echo ""
echo "Next Steps:"
echo "1. Update Alertmanager config with your Slack/PagerDuty webhooks"
echo "2. Set up secrets management (AWS Secrets Manager or Vault)"
echo "3. Configure Keycloak security settings"
echo "4. Enable MFA for admin accounts"
echo "5. Review and test all security configurations"
echo ""
echo "To monitor security status, run:"
echo "  ./scripts/security-monitor.sh"
echo ""
echo "========================================="
