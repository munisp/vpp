# Production Security Configuration Guide

This guide provides comprehensive security hardening procedures for deploying the VPP Platform in production.

## Security Overview

The VPP Platform security architecture includes:

1. **Transport Layer Security (TLS)** - Encrypted communication for all services
2. **Authentication & Authorization** - Keycloak SSO with MFA
3. **Secrets Management** - Secure credential storage and rotation
4. **Network Security** - Firewall rules and service isolation
5. **Audit Logging** - Comprehensive activity tracking
6. **Data Protection** - Encryption at rest and in transit

## Critical Security Checklist

### Immediate Actions (Before Production)

- [ ] Change all default passwords
- [ ] Enable TLS for all services
- [ ] Configure firewall rules
- [ ] Set up secrets management
- [ ] Enable audit logging
- [ ] Configure brute force protection
- [ ] Set up MFA for admin accounts
- [ ] Review and restrict API access
- [ ] Enable rate limiting
- [ ] Configure CORS properly

## 1. TLS/SSL Configuration

### Generate SSL Certificates

**Option 1: Let's Encrypt (Recommended for Production)**

```bash
# Install Certbot
sudo apt-get update
sudo apt-get install certbot python3-certbot-nginx

# Generate certificate
sudo certbot certonly --standalone -d vpp-platform.yourdomain.com

# Certificates will be saved to:
# /etc/letsencrypt/live/vpp-platform.yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/vpp-platform.yourdomain.com/privkey.pem
```

**Option 2: Self-Signed (Development/Testing)**

```bash
# Generate self-signed certificate
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/vpp-selfsigned.key \
  -out /etc/ssl/certs/vpp-selfsigned.crt \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=vpp-platform.local"
```

### Configure TLS for VPP Web Server

Create Nginx reverse proxy configuration:

```nginx
# /etc/nginx/sites-available/vpp-platform
server {
    listen 443 ssl http2;
    server_name vpp-platform.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/vpp-platform.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vpp-platform.yourdomain.com/privkey.pem;
    
    # SSL Configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;
    
    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    
    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name vpp-platform.yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/vpp-platform /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Configure TLS for Keycloak

Edit Keycloak configuration:

```bash
# Edit standalone.xml or standalone-ha.xml
vi /opt/keycloak/standalone/configuration/standalone.xml
```

Add SSL configuration:

```xml
<security-realm name="ApplicationRealm">
    <server-identities>
        <ssl>
            <keystore path="keycloak.jks" 
                      relative-to="jboss.server.config.dir" 
                      keystore-password="changeit" 
                      alias="server" 
                      key-password="changeit"/>
        </ssl>
    </server-identities>
</security-realm>
```

### Configure TLS for Kafka

Edit `server.properties`:

```properties
# Enable SSL
listeners=SSL://localhost:9093
advertised.listeners=SSL://kafka.yourdomain.com:9093

# SSL Configuration
ssl.keystore.location=/var/private/ssl/kafka.server.keystore.jks
ssl.keystore.password=changeit
ssl.key.password=changeit
ssl.truststore.location=/var/private/ssl/kafka.server.truststore.jks
ssl.truststore.password=changeit

# Client authentication
ssl.client.auth=required
```

### Configure TLS for Redis

Edit `redis.conf`:

```conf
# Enable TLS
port 0
tls-port 6379

# TLS Configuration
tls-cert-file /etc/redis/tls/redis.crt
tls-key-file /etc/redis/tls/redis.key
tls-ca-cert-file /etc/redis/tls/ca.crt

# Client authentication
tls-auth-clients yes
```

### Configure TLS for Temporal

Edit Temporal server configuration:

```yaml
# config.yaml
tls:
  internode:
    server:
      certFile: /etc/temporal/tls/server.crt
      keyFile: /etc/temporal/tls/server.key
    client:
      rootCaFiles:
        - /etc/temporal/tls/ca.crt
  frontend:
    server:
      certFile: /etc/temporal/tls/server.crt
      keyFile: /etc/temporal/tls/server.key
    client:
      rootCaFiles:
        - /etc/temporal/tls/ca.crt
```

## 2. Keycloak Security Configuration

### Password Policies

1. Go to **Realm Settings** → **Security Defenses** → **Password Policy**
2. Add policies:
   - **Minimum Length**: 12
   - **Uppercase Characters**: 1
   - **Lowercase Characters**: 1
   - **Digits**: 1
   - **Special Characters**: 1
   - **Not Username**: Enabled
   - **Not Email**: Enabled
   - **Password History**: 5
   - **Expire Password**: 90 days

### Brute Force Detection

1. Go to **Realm Settings** → **Security Defenses** → **Brute Force Detection**
2. Enable **Brute Force Detection**
3. Configure:
   - **Max Login Failures**: 5
   - **Wait Increment**: 60 seconds
   - **Max Wait**: 900 seconds (15 minutes)
   - **Failure Reset Time**: 43200 seconds (12 hours)
   - **Quick Login Check**: 1000 milliseconds

### Multi-Factor Authentication (MFA)

1. Go to **Authentication** → **Required Actions**
2. Enable **Configure OTP**
3. Go to **Authentication** → **Flows**
4. Edit **Browser** flow:
   - Add **OTP Form** execution
   - Set to **Required**

### Session Management

1. Go to **Realm Settings** → **Tokens**
2. Configure:
   - **SSO Session Idle**: 30 minutes
   - **SSO Session Max**: 10 hours
   - **Access Token Lifespan**: 5 minutes
   - **Refresh Token Max Reuse**: 0
   - **Refresh Token Max**: 30 minutes

### Email Verification

1. Go to **Realm Settings** → **Login**
2. Enable **Verify Email**
3. Configure SMTP settings:
   - **Host**: smtp.yourdomain.com
   - **Port**: 587
   - **From**: noreply@yourdomain.com
   - **Enable SSL**: Yes
   - **Enable Authentication**: Yes

## 3. Secrets Management

### Option 1: AWS Secrets Manager

Install AWS CLI:

```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

Store secrets:

```bash
# Store Keycloak client secret
aws secretsmanager create-secret \
  --name vpp/keycloak/client-secret \
  --secret-string "your-client-secret"

# Store database password
aws secretsmanager create-secret \
  --name vpp/database/password \
  --secret-string "your-db-password"

# Store Kafka credentials
aws secretsmanager create-secret \
  --name vpp/kafka/credentials \
  --secret-string '{"username":"kafka-user","password":"kafka-pass"}'
```

Retrieve secrets in application:

```typescript
// server/secrets.ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({ region: "us-east-1" });

export async function getSecret(secretName: string): Promise<string> {
  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(command);
  return response.SecretString || "";
}

// Usage
const keycloakSecret = await getSecret("vpp/keycloak/client-secret");
```

### Option 2: HashiCorp Vault

Install Vault:

```bash
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo apt-key add -
sudo apt-add-repository "deb [arch=amd64] https://apt.releases.hashicorp.com $(lsb_release -cs) main"
sudo apt-get update && sudo apt-get install vault
```

Initialize and unseal:

```bash
vault server -dev
export VAULT_ADDR='http://127.0.0.1:8200'
vault status
```

Store secrets:

```bash
# Enable KV secrets engine
vault secrets enable -path=vpp kv-v2

# Store secrets
vault kv put vpp/keycloak client-secret="your-secret"
vault kv put vpp/database password="your-password"
vault kv put vpp/kafka username="kafka-user" password="kafka-pass"
```

Retrieve secrets:

```typescript
// server/vault.ts
import axios from 'axios';

const VAULT_ADDR = process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
const VAULT_TOKEN = process.env.VAULT_TOKEN;

export async function getVaultSecret(path: string): Promise<any> {
  const response = await axios.get(`${VAULT_ADDR}/v1/vpp/data/${path}`, {
    headers: { 'X-Vault-Token': VAULT_TOKEN }
  });
  return response.data.data.data;
}

// Usage
const keycloakCreds = await getVaultSecret('keycloak');
```

### Option 3: Environment Variables with Encryption

Use `dotenv-vault` for encrypted environment variables:

```bash
npm install dotenv-vault
npx dotenv-vault new
```

Encrypt secrets:

```bash
npx dotenv-vault encrypt
```

Load in application:

```typescript
// server/index.ts
import 'dotenv-vault/config';

// Secrets are automatically decrypted and loaded
const keycloakSecret = process.env.KEYCLOAK_CLIENT_SECRET;
```

## 4. Network Security

### Firewall Configuration (UFW)

```bash
# Enable UFW
sudo ufw enable

# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTPS
sudo ufw allow 443/tcp

# Allow HTTP (for redirect)
sudo ufw allow 80/tcp

# Deny all other incoming
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Check status
sudo ufw status verbose
```

### Service Isolation with Docker Networks

```yaml
# docker-compose.yml
version: '3.8'

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
  database:
    driver: bridge
    internal: true  # No external access

services:
  web:
    networks:
      - frontend
      - backend
  
  keycloak:
    networks:
      - frontend
      - database
  
  kafka:
    networks:
      - backend
  
  redis:
    networks:
      - backend
  
  postgres:
    networks:
      - database
```

### IP Whitelisting

Configure Nginx to restrict access:

```nginx
# Allow specific IPs
location /admin {
    allow 192.168.1.0/24;
    allow 10.0.0.0/8;
    deny all;
    
    proxy_pass http://localhost:3000;
}
```

## 5. Audit Logging

### Enable Keycloak Event Logging

1. Go to **Realm Settings** → **Events**
2. **Login Events Settings**:
   - Enable **Save Events**
   - Set **Expiration**: 365 days
   - Select events to log (all recommended)
3. **Admin Events Settings**:
   - Enable **Save Events**
   - Enable **Include Representation**

### Application Audit Logging

Create audit logger:

```typescript
// server/audit-logger.ts
import { createLogger, format, transports } from 'winston';

export const auditLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'logs/audit.log' }),
    new transports.File({ filename: 'logs/audit-error.log', level: 'error' })
  ]
});

export function logAuditEvent(event: {
  userId: string;
  action: string;
  resource: string;
  result: 'success' | 'failure';
  metadata?: any;
}) {
  auditLogger.info({
    timestamp: new Date().toISOString(),
    ...event
  });
}
```

Usage:

```typescript
// Log authentication
logAuditEvent({
  userId: user.id,
  action: 'login',
  resource: 'authentication',
  result: 'success',
  metadata: { ip: req.ip, userAgent: req.headers['user-agent'] }
});

// Log data access
logAuditEvent({
  userId: user.id,
  action: 'read',
  resource: 'user-data',
  result: 'success',
  metadata: { recordId: '12345' }
});
```

### Centralized Logging with ELK Stack

**Docker Compose configuration:**

```yaml
elasticsearch:
  image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
  environment:
    - discovery.type=single-node
    - xpack.security.enabled=false
  ports:
    - "9200:9200"

logstash:
  image: docker.elastic.co/logstash/logstash:8.11.0
  volumes:
    - ./logstash.conf:/usr/share/logstash/pipeline/logstash.conf
  ports:
    - "5044:5044"

kibana:
  image: docker.elastic.co/kibana/kibana:8.11.0
  ports:
    - "5601:5601"
  environment:
    - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
```

## 6. Rate Limiting

### Nginx Rate Limiting

```nginx
# Define rate limit zone
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=login_limit:10m rate=5r/m;

server {
    # API endpoints
    location /api {
        limit_req zone=api_limit burst=20 nodelay;
        proxy_pass http://localhost:3000;
    }
    
    # Login endpoint
    location /api/auth/login {
        limit_req zone=login_limit burst=5 nodelay;
        proxy_pass http://localhost:3000;
    }
}
```

### Application-Level Rate Limiting

```typescript
// server/middleware/rate-limiter.ts
import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Limit each IP to 5 login attempts per windowMs
  skipSuccessfulRequests: true,
});

// Usage
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
```

## 7. CORS Configuration

```typescript
// server/middleware/cors.ts
import cors from 'cors';

const allowedOrigins = [
  'https://vpp-platform.yourdomain.com',
  'https://admin.vpp-platform.yourdomain.com'
];

export const corsOptions = {
  origin: (origin: string | undefined, callback: Function) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

// Usage
app.use(cors(corsOptions));
```

## 8. Database Security

### Connection Security

```typescript
// Use SSL for database connections
const db = drizzle(mysql({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    ca: fs.readFileSync('/path/to/ca-cert.pem'),
    rejectUnauthorized: true
  }
}));
```

### Encryption at Rest

Enable MySQL encryption:

```sql
-- Enable encryption for tablespace
ALTER TABLESPACE mysql ENCRYPTION='Y';

-- Create encrypted table
CREATE TABLE users (
  id INT PRIMARY KEY,
  email VARCHAR(255)
) ENCRYPTION='Y';
```

### Principle of Least Privilege

```sql
-- Create application user with limited permissions
CREATE USER 'vpp_app'@'localhost' IDENTIFIED BY 'strong_password';

-- Grant only necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON vpp_platform.* TO 'vpp_app'@'localhost';

-- Revoke dangerous permissions
REVOKE DROP, CREATE, ALTER ON vpp_platform.* FROM 'vpp_app'@'localhost';

FLUSH PRIVILEGES;
```

## 9. Security Monitoring

### Set Up Security Alerts

```typescript
// server/security-monitor.ts
import { auditLogger } from './audit-logger';
import { notifyOwner } from './_core/notification';

export function monitorSecurityEvents() {
  // Monitor failed login attempts
  let failedLogins = new Map<string, number>();
  
  setInterval(() => {
    failedLogins.forEach((count, ip) => {
      if (count > 10) {
        auditLogger.warn(`Suspicious activity: ${count} failed logins from ${ip}`);
        notifyOwner({
          title: 'Security Alert: Multiple Failed Logins',
          content: `IP ${ip} has ${count} failed login attempts in the last hour.`
        });
      }
    });
    failedLogins.clear();
  }, 60 * 60 * 1000); // Check every hour
}
```

### Intrusion Detection

Install and configure Fail2Ban:

```bash
sudo apt-get install fail2ban

# Create jail for VPP Platform
sudo vi /etc/fail2ban/jail.local
```

```ini
[vpp-auth]
enabled = true
port = https,http
filter = vpp-auth
logpath = /home/ubuntu/vpp_consumer_platform/logs/auth.log
maxretry = 5
bantime = 3600
findtime = 600
```

## 10. Compliance & Best Practices

### GDPR Compliance

1. **Data Minimization**: Only collect necessary data
2. **Right to Access**: Implement user data export
3. **Right to Erasure**: Implement account deletion
4. **Data Portability**: Provide data in machine-readable format
5. **Consent Management**: Track and manage user consents

### OWASP Top 10 Mitigation

1. **Injection**: Use parameterized queries (Drizzle ORM)
2. **Broken Authentication**: Implement MFA, session management
3. **Sensitive Data Exposure**: Encrypt data at rest and in transit
4. **XML External Entities**: Disable XML parsing or use safe parsers
5. **Broken Access Control**: Implement RBAC with Keycloak
6. **Security Misconfiguration**: Follow this security guide
7. **XSS**: Sanitize user input, use Content Security Policy
8. **Insecure Deserialization**: Validate and sanitize serialized data
9. **Using Components with Known Vulnerabilities**: Regular dependency updates
10. **Insufficient Logging**: Comprehensive audit logging

### Regular Security Tasks

**Daily:**
- [ ] Review security logs
- [ ] Check for suspicious activity
- [ ] Monitor failed login attempts

**Weekly:**
- [ ] Review access logs
- [ ] Check for outdated dependencies (`npm audit`)
- [ ] Verify backup integrity

**Monthly:**
- [ ] Update dependencies
- [ ] Review and rotate secrets
- [ ] Conduct security scan
- [ ] Review user permissions

**Quarterly:**
- [ ] Security audit
- [ ] Penetration testing
- [ ] Review and update security policies
- [ ] Security training for team

## Production Security Checklist

### Pre-Deployment

- [ ] All default passwords changed
- [ ] TLS enabled for all services
- [ ] Firewall rules configured
- [ ] Secrets management implemented
- [ ] Audit logging enabled
- [ ] Rate limiting configured
- [ ] CORS properly configured
- [ ] Security headers added
- [ ] Database encryption enabled
- [ ] MFA enabled for admins

### Post-Deployment

- [ ] Security monitoring active
- [ ] Alerts configured
- [ ] Backup strategy tested
- [ ] Incident response plan documented
- [ ] Security contacts updated
- [ ] Compliance requirements met
- [ ] Regular security scans scheduled
- [ ] Team security training completed

## Emergency Response

### Security Incident Response Plan

1. **Detect**: Monitor logs and alerts
2. **Contain**: Isolate affected systems
3. **Investigate**: Determine scope and impact
4. **Remediate**: Fix vulnerabilities
5. **Recover**: Restore normal operations
6. **Learn**: Document and improve

### Emergency Contacts

- Security Team: security@yourdomain.com
- On-Call Engineer: +1-XXX-XXX-XXXX
- Incident Response: incidents@yourdomain.com

## Additional Resources

- [OWASP Security Guidelines](https://owasp.org/)
- [CIS Benchmarks](https://www.cisecurity.org/cis-benchmarks/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
- [Keycloak Security Guide](https://www.keycloak.org/docs/latest/server_admin/#security)

For questions or security concerns, contact: security@yourdomain.com
