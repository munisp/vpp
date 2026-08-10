# VPP Platform - Production Deployment Guide

Complete guide for deploying the VPP Consumer Platform to production infrastructure.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Infrastructure Setup](#infrastructure-setup)
3. [Environment Configuration](#environment-configuration)
4. [Database Setup](#database-setup)
5. [Service Deployment](#service-deployment)
6. [Monitoring Setup](#monitoring-setup)
7. [SSL/TLS Configuration](#ssltls-configuration)
8. [Backup & Recovery](#backup--recovery)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Hardware Requirements

**Web Application Server:**
- CPU: 4+ cores
- RAM: 8GB minimum, 16GB recommended
- Storage: 100GB SSD
- Network: 1Gbps

**Database Server:**
- CPU: 4+ cores
- RAM: 16GB minimum, 32GB recommended
- Storage: 500GB SSD (RAID 10)
- Network: 1Gbps

**MQTT/Fluvio Cluster:**
- CPU: 8+ cores per node
- RAM: 16GB minimum per node
- Storage: 1TB SSD per node
- Network: 10Gbps
- Nodes: 3+ for high availability

### Software Requirements

- Ubuntu 22.04 LTS or later
- Docker 24.0+ and Docker Compose 2.20+
- Node.js 22.x
- MySQL 8.0+ or TiDB 7.0+
- Nginx 1.24+
- Certbot for SSL certificates

---

## Infrastructure Setup

### 1. Server Provisioning

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt install docker-compose-plugin

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm
npm install -g pnpm
```

### 2. Network Configuration

```bash
# Configure firewall
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 1883/tcp  # MQTT
sudo ufw allow 8883/tcp  # MQTT TLS
sudo ufw allow 9003/tcp  # Fluvio
sudo ufw enable

# Configure DNS
# Point your domain to server IP:
# - app.yourdomain.com → Web Application
# - mqtt.yourdomain.com → MQTT Broker
# - api.yourdomain.com → API Server
```

---

## Environment Configuration

### 1. Create Environment Files

```bash
# Production environment
cat > .env.production << 'EOF'
# Application
NODE_ENV=production
PORT=3000
VITE_APP_TITLE="VPP Consumer Platform"
VITE_APP_LOGO="/logo.svg"

# Database
DATABASE_URL="mysql://user:password@db-server:3306/vpp_production"

# Authentication
JWT_SECRET="your-super-secret-jwt-key-change-this"
OAUTH_SERVER_URL="https://api.yourdomain.com/oauth"
VITE_OAUTH_PORTAL_URL="https://app.yourdomain.com/login"

# Payment Gateways
MPESA_CONSUMER_KEY="your-mpesa-consumer-key"
MPESA_CONSUMER_SECRET="your-mpesa-consumer-secret"
MPESA_SHORTCODE="your-shortcode"
MPESA_PASSKEY="your-passkey"

AIRTEL_CLIENT_ID="your-airtel-client-id"
AIRTEL_CLIENT_SECRET="your-airtel-client-secret"

TIGO_API_KEY="your-tigo-api-key"
TIGO_API_SECRET="your-tigo-api-secret"

# Notifications
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_USER="your-email@gmail.com"
SMTP_PASSWORD="your-app-password"

AFRICAS_TALKING_API_KEY="your-at-api-key"
AFRICAS_TALKING_USERNAME="your-at-username"

# MQTT/Fluvio
MQTT_BROKER_URL="mqtt://mqtt.yourdomain.com:1883"
MQTT_USERNAME="vpp_bridge"
MQTT_PASSWORD="secure-mqtt-password"

FLUVIO_CLUSTER_URL="fluvio://fluvio.yourdomain.com:9003"

# Monitoring
PROMETHEUS_URL="http://prometheus:9090"
GRAFANA_URL="http://grafana:3001"
EOF

# Set permissions
chmod 600 .env.production
```

### 2. Environment-Specific Configurations

Create separate configs for dev/staging/production:

```bash
# Development
cp .env.production .env.development
# Edit for local development (localhost, test credentials)

# Staging
cp .env.production .env.staging
# Edit for staging environment
```

---

## Database Setup

### 1. Create Database

```sql
-- Connect to MySQL
mysql -u root -p

-- Create database
CREATE DATABASE vpp_production CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create user
CREATE USER 'vpp_user'@'%' IDENTIFIED BY 'secure-password';
GRANT ALL PRIVILEGES ON vpp_production.* TO 'vpp_user'@'%';
FLUSH PRIVILEGES;
```

### 2. Run Migrations

```bash
# Install dependencies
cd /path/to/vpp_consumer_platform
pnpm install

# Push schema to database
pnpm db:push

# Verify tables
mysql -u vpp_user -p vpp_production -e "SHOW TABLES;"
```

### 3. Seed Initial Data (Optional)

```bash
# Create admin user
node scripts/create-admin.js

# Seed market prices
node scripts/seed-prices.js
```

---

## Service Deployment

### 1. Web Application

```bash
# Build application
cd /path/to/vpp_consumer_platform
NODE_ENV=production pnpm build

# Install PM2 for process management
npm install -g pm2

# Start the built application.
# NOTE: `pm2 start server/_core/index.ts --interpreter=node` does NOT work —
# the node interpreter cannot execute TypeScript. Run the compiled bundle
# (produced by `pnpm build` above) or use tsx as the interpreter.
pm2 start dist/index.js --name vpp-app
# Alternative (runs TypeScript directly):
#   pm2 start server/_core/index.ts --name vpp-app --interpreter=node --node-args="--import tsx"
pm2 save
pm2 startup

# Configure Nginx reverse proxy
sudo nano /etc/nginx/sites-available/vpp-app

# Add configuration:
server {
    listen 80;
    server_name app.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

# Enable site
sudo ln -s /etc/nginx/sites-available/vpp-app /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 2. MQTT/Fluvio Stack

```bash
# Deploy services
cd services
./deploy.sh

# Verify services
docker-compose ps

# Check logs
docker-compose logs -f mqtt-fluvio-bridge
```

### 3. Python Consumers

```bash
# Create systemd services
sudo nano /etc/systemd/system/vpp-database-consumer.service

# Add:
[Unit]
Description=VPP Database Consumer
After=docker.service
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=10
WorkingDirectory=/path/to/vpp_consumer_platform/services
ExecStart=/usr/bin/docker-compose up database-consumer

[Install]
WantedBy=multi-user.target

# Enable and start
sudo systemctl enable vpp-database-consumer
sudo systemctl start vpp-database-consumer
```

---

## Monitoring Setup

### 1. Prometheus

```bash
# Start Prometheus
docker-compose up -d prometheus

# Verify targets
curl http://localhost:9090/api/v1/targets
```

### 2. Grafana

```bash
# Start Grafana
docker-compose up -d grafana

# Access: http://localhost:3001
# Login: admin / admin (change on first login)

# Import dashboard
# Dashboard > Import > Upload grafana-dashboard.json
```

### 3. Alertmanager (Optional)

```bash
# Configure Slack/Email alerts
nano monitoring/alertmanager.yml

# Start Alertmanager
docker-compose up -d alertmanager
```

---

## SSL/TLS Configuration

### 1. Obtain Certificates

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificates
sudo certbot --nginx -d app.yourdomain.com
sudo certbot --nginx -d mqtt.yourdomain.com
sudo certbot --nginx -d api.yourdomain.com

# Auto-renewal
sudo certbot renew --dry-run
```

### 2. Configure MQTT TLS

```bash
# Copy certificates
sudo cp /etc/letsencrypt/live/mqtt.yourdomain.com/fullchain.pem mqtt/certs/
sudo cp /etc/letsencrypt/live/mqtt.yourdomain.com/privkey.pem mqtt/certs/

# Update mosquitto.conf
listener 8883
certfile /mosquitto/certs/fullchain.pem
keyfile /mosquitto/certs/privkey.pem

# Restart MQTT broker
docker-compose restart mosquitto
```

---

## Backup & Recovery

### 1. Database Backup

```bash
# Create backup script
cat > /usr/local/bin/vpp-backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/var/backups/vpp"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Backup database
mysqldump -u vpp_user -p'password' vpp_production | gzip > $BACKUP_DIR/db_$DATE.sql.gz

# Backup uploaded files (if any)
tar -czf $BACKUP_DIR/files_$DATE.tar.gz /path/to/uploads

# Keep only last 30 days
find $BACKUP_DIR -name "*.gz" -mtime +30 -delete

echo "Backup completed: $DATE"
EOF

chmod +x /usr/local/bin/vpp-backup.sh

# Schedule daily backups
crontab -e
# Add: 0 2 * * * /usr/local/bin/vpp-backup.sh
```

### 2. Recovery

```bash
# Restore database
gunzip < /var/backups/vpp/db_20240115_020000.sql.gz | mysql -u vpp_user -p vpp_production

# Restore files
tar -xzf /var/backups/vpp/files_20240115_020000.tar.gz -C /
```

---

## Troubleshooting

### Application Won't Start

```bash
# Check logs
pm2 logs vpp-app

# Check database connection
mysql -u vpp_user -p -h db-server vpp_production

# Check environment variables
pm2 env vpp-app
```

### MQTT Connection Issues

```bash
# Test MQTT connection
mosquitto_sub -h mqtt.yourdomain.com -p 1883 -t 'test' -v

# Check broker logs
docker-compose logs mosquitto

# Verify firewall
sudo ufw status
```

### High Memory Usage

```bash
# Check container stats
docker stats

# Restart services
docker-compose restart

# Scale consumers
docker-compose up -d --scale database-consumer=3
```

### Database Performance

```bash
# Check slow queries
mysql -u root -p -e "SELECT * FROM mysql.slow_log ORDER BY query_time DESC LIMIT 10;"

# Optimize tables
mysql -u vpp_user -p vpp_production -e "OPTIMIZE TABLE telemetry;"

# Add indexes if needed
```

---

## Health Checks

```bash
# Run health check script
cd services
./healthcheck.sh

# Check application health
curl https://app.yourdomain.com/api/health

# Check MQTT broker
mosquitto_sub -h mqtt.yourdomain.com -p 1883 -t '$SYS/#' -C 1

# Check Fluvio cluster
docker-compose exec fluvio fluvio cluster status
```

---

## Performance Tuning

### Database

```sql
-- Increase connection pool
SET GLOBAL max_connections = 500;

-- Enable query cache
SET GLOBAL query_cache_size = 268435456;
```

### Node.js

```bash
# Increase memory limit
pm2 start dist/index.js --max-memory-restart 2G

# Use cluster mode
pm2 start dist/index.js -i max
```

### MQTT

```
# mosquitto.conf
max_connections 10000
max_queued_messages 10000
message_size_limit 10485760
```

---

## Security Checklist

- [ ] Change all default passwords
- [ ] Enable firewall (UFW)
- [ ] Configure SSL/TLS for all services
- [ ] Set up fail2ban for SSH protection
- [ ] Enable database encryption at rest
- [ ] Configure regular security updates
- [ ] Set up intrusion detection (OSSEC)
- [ ] Enable audit logging
- [ ] Configure CORS properly
- [ ] Use environment variables for secrets
- [ ] Set up VPN for internal services
- [ ] Enable 2FA for admin accounts

---

## Maintenance

### Regular Tasks

**Daily:**
- Check application logs
- Verify backup completion
- Monitor disk space

**Weekly:**
- Review Grafana dashboards
- Check for security updates
- Review error rates

**Monthly:**
- Update dependencies
- Review database performance
- Test backup restoration
- Review access logs

---

## Support

For issues or questions:
- Documentation: `/docs`
- GitHub Issues: `https://github.com/your-org/vpp-platform/issues`
- Email: support@yourdomain.com
