# MQTT Broker Deployment Guide

Production-ready Mosquitto MQTT broker setup for VPP Consumer Platform.

## Quick Start

```bash
cd mqtt
sudo ./deploy.sh
```

The script will:
1. Install Mosquitto broker
2. Generate SSL/TLS certificates
3. Create admin and server users
4. Configure access control
5. Start the broker service

## Manual Installation

### 1. Install Mosquitto

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install mosquitto mosquitto-clients
```

**CentOS/RHEL:**
```bash
sudo yum install mosquitto mosquitto-clients
```

**macOS:**
```bash
brew install mosquitto
```

### 2. Generate SSL Certificates

```bash
# Create certificates directory
sudo mkdir -p /etc/mosquitto/certs
cd /etc/mosquitto/certs

# Generate CA
sudo openssl genrsa -out ca.key 4096
sudo openssl req -new -x509 -days 3650 -key ca.key -out ca.crt

# Generate server certificate
sudo openssl genrsa -out server.key 4096
sudo openssl req -new -key server.key -out server.csr
sudo openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt -days 3650
```

### 3. Create Users

```bash
# Create admin user
sudo mosquitto_passwd -c /etc/mosquitto/passwd vpp-admin

# Add server user
sudo mosquitto_passwd /etc/mosquitto/passwd vpp-server

# Add device users
sudo mosquitto_passwd /etc/mosquitto/passwd device-123-456
```

### 4. Configure Mosquitto

Copy configuration files:

```bash
sudo cp mosquitto.conf /etc/mosquitto/mosquitto.conf
sudo cp acl /etc/mosquitto/acl
```

### 5. Start Service

```bash
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
sudo systemctl status mosquitto
```

## Configuration

### Ports

- **1883** - Plain MQTT (development only)
- **8883** - MQTTS with SSL/TLS (production)
- **8884** - WebSocket with SSL (web clients)

### Authentication

The broker uses password-based authentication. Users are stored in `/etc/mosquitto/passwd`.

**Add new user:**
```bash
sudo mosquitto_passwd /etc/mosquitto/passwd username
```

**Update password:**
```bash
sudo mosquitto_passwd /etc/mosquitto/passwd username
```

**Delete user:**
Edit `/etc/mosquitto/passwd` and remove the line.

### Access Control

ACL rules in `/etc/mosquitto/acl` control topic access:

```
# Device pattern - can only access own topics
pattern read vpp/%u/+/command/#
pattern write vpp/%u/+/telemetry
```

The `%u` wildcard is replaced with the username.

## Testing

### Test Plain MQTT (Development)

```bash
# Subscribe
mosquitto_sub -h localhost -p 1883 -u vpp-admin -P password -t "vpp/#" -v

# Publish
mosquitto_pub -h localhost -p 1883 -u vpp-admin -P password \
  -t "vpp/test" -m "Hello MQTT"
```

### Test MQTTS (Production)

```bash
# Subscribe with TLS
mosquitto_sub -h localhost -p 8883 \
  --cafile /etc/mosquitto/certs/ca.crt \
  -u vpp-admin -P password \
  -t "vpp/#" -v

# Publish with TLS
mosquitto_pub -h localhost -p 8883 \
  --cafile /etc/mosquitto/certs/ca.crt \
  -u vpp-admin -P password \
  -t "vpp/123/456/telemetry" \
  -m '{"deviceId":"SM-001","timestamp":1704067200000,"power":5000}'
```

### Test WebSocket

Use a WebSocket MQTT client library or tool like MQTT.fx.

## Monitoring

### View Logs

```bash
# Real-time logs
sudo tail -f /var/log/mosquitto/mosquitto.log

# System logs
sudo journalctl -u mosquitto -f
```

### Check Status

```bash
# Service status
sudo systemctl status mosquitto

# Active connections
sudo mosquitto_sub -h localhost -p 1883 -u vpp-admin -P password \
  -t '$SYS/broker/clients/connected' -v
```

### Metrics

Subscribe to system topics for metrics:

```bash
mosquitto_sub -h localhost -p 1883 -u vpp-admin -P password \
  -t '$SYS/#' -v
```

Key metrics:
- `$SYS/broker/clients/connected` - Connected clients
- `$SYS/broker/messages/received` - Total messages received
- `$SYS/broker/messages/sent` - Total messages sent
- `$SYS/broker/uptime` - Broker uptime

## Security

### SSL/TLS Best Practices

1. **Use strong certificates** - 4096-bit RSA keys
2. **Regular rotation** - Renew certificates annually
3. **Secure storage** - Protect private keys (chmod 600)
4. **Disable plain MQTT** - Use port 8883 only in production

### Authentication Best Practices

1. **Strong passwords** - Minimum 32 characters
2. **Unique credentials** - Different password per device
3. **Rotate credentials** - Change passwords regularly
4. **Principle of least privilege** - Use ACLs to restrict access

### Network Security

1. **Firewall rules** - Only allow necessary ports
2. **VPN/Private network** - Keep broker on private network
3. **Rate limiting** - Prevent DoS attacks
4. **IP whitelisting** - Restrict by source IP if possible

## Troubleshooting

### Connection Refused

**Symptom:** `Error: Connection refused`

**Solutions:**
- Check if Mosquitto is running: `sudo systemctl status mosquitto`
- Verify firewall allows port: `sudo ufw status`
- Check broker logs: `sudo tail /var/log/mosquitto/mosquitto.log`

### Authentication Failed

**Symptom:** `Connection Refused: not authorised`

**Solutions:**
- Verify username/password: `cat /etc/mosquitto/passwd`
- Check ACL rules: `cat /etc/mosquitto/acl`
- Ensure `allow_anonymous false` in config

### SSL/TLS Errors

**Symptom:** `Error: A TLS error occurred`

**Solutions:**
- Verify certificate paths in config
- Check certificate validity: `openssl x509 -in server.crt -text -noout`
- Ensure CA certificate matches server certificate
- Check file permissions: `ls -la /etc/mosquitto/certs/`

### High Memory Usage

**Solutions:**
- Reduce `max_queued_messages` in config
- Enable `persistent_client_expiration`
- Monitor with `$SYS/broker/heap/current`

### Message Loss

**Solutions:**
- Use QoS 1 or 2 for important messages
- Enable persistence in config
- Check disk space: `df -h`

## Performance Tuning

### For High Throughput

```conf
# mosquitto.conf
max_inflight_messages 100
max_queued_messages 10000
message_size_limit 10485760
```

### For Many Clients

```conf
max_connections 10000
keepalive_interval 30
```

### For Low Latency

```conf
max_inflight_messages 20
persistent_client_expiration 1h
```

## Backup and Recovery

### Backup

```bash
# Backup configuration
sudo tar -czf mosquitto-backup.tar.gz \
  /etc/mosquitto/mosquitto.conf \
  /etc/mosquitto/acl \
  /etc/mosquitto/passwd \
  /etc/mosquitto/certs/

# Backup persistence data
sudo tar -czf mosquitto-data-backup.tar.gz \
  /var/lib/mosquitto/
```

### Restore

```bash
# Restore configuration
sudo tar -xzf mosquitto-backup.tar.gz -C /

# Restore data
sudo tar -xzf mosquitto-data-backup.tar.gz -C /

# Restart service
sudo systemctl restart mosquitto
```

## Scaling

### Vertical Scaling

Increase server resources:
- CPU: 2+ cores for 1000+ concurrent clients
- RAM: 4GB+ for 10,000+ clients
- Disk: SSD for persistence

### Horizontal Scaling

Use MQTT bridge to connect multiple brokers:

```conf
# mosquitto.conf on edge broker
connection bridge-to-central
address central.mqtt.example.com:8883
topic vpp/# both 0
bridge_cafile /etc/mosquitto/certs/ca.crt
```

### Load Balancing

Use HAProxy or Nginx for load balancing:

```nginx
stream {
  upstream mqtt_backend {
    server mqtt1.example.com:8883;
    server mqtt2.example.com:8883;
  }
  
  server {
    listen 8883;
    proxy_pass mqtt_backend;
  }
}
```

## Cloud Deployment

### AWS

Use Amazon MQ for managed MQTT or deploy on EC2:

```bash
# Launch EC2 instance
aws ec2 run-instances --image-id ami-xxx --instance-type t3.medium

# Install and configure
ssh ubuntu@ec2-xxx.compute.amazonaws.com
sudo ./deploy.sh
```

### Docker

```dockerfile
FROM eclipse-mosquitto:latest
COPY mosquitto.conf /mosquitto/config/
COPY acl /mosquitto/config/
COPY passwd /mosquitto/config/
COPY certs/ /mosquitto/certs/
EXPOSE 1883 8883 8884
```

```bash
docker build -t vpp-mqtt .
docker run -d -p 8883:8883 --name mqtt vpp-mqtt
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mosquitto
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: mosquitto
        image: vpp-mqtt:latest
        ports:
        - containerPort: 8883
---
apiVersion: v1
kind: Service
metadata:
  name: mosquitto
spec:
  type: LoadBalancer
  ports:
  - port: 8883
    targetPort: 8883
```

## Support

For issues or questions:
- Check logs: `/var/log/mosquitto/mosquitto.log`
- Mosquitto documentation: https://mosquitto.org/documentation/
- MQTT protocol: https://mqtt.org/

## License

Proprietary - VPP Consumer Platform
