# VPP MQTT-Fluvio Integration

High-performance IoT data streaming pipeline using MQTT, Fluvio, Go, and Python.

## Architecture

```
IoT Devices → MQTT Broker → Go Bridge → Fluvio → Python Consumers → Database/Analytics
```

### Components

1. **Mosquitto MQTT Broker** - Receives telemetry from IoT devices
2. **MQTT-Fluvio Bridge (Go)** - High-performance bridge service
   - Subscribes to MQTT topics
   - Validates and transforms data
   - Publishes to Fluvio topics
3. **Fluvio Cluster** - Distributed streaming platform
4. **Database Consumer (Python)** - Stores telemetry in MySQL
5. **Analytics Consumer (Python)** - Real-time windowed aggregations

## Features

- **High Throughput**: Go bridge handles 10,000+ messages/second
- **Fault Tolerant**: Automatic reconnection and retry logic
- **Scalable**: Horizontal scaling via Fluvio partitions
- **Type Safe**: Pydantic models for data validation
- **Observable**: Structured logging with loguru and logrus

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Go 1.21+ (for development)
- Python 3.11+ (for development)

### Deployment

1. **Configure environment variables**:
```bash
cp .env.example .env
# Edit .env with your configuration
```

2. **Deploy all services**:
```bash
cd services
./deploy.sh
```

3. **Verify deployment**:
```bash
docker-compose ps
docker-compose logs -f
```

### Manual Setup (Development)

#### 1. Start Fluvio Cluster

```bash
# Install Fluvio CLI
curl -fsS https://hub.infinyon.cloud/install/install.sh | bash

# Start local cluster
fluvio cluster start

# Create topics
fluvio topic create telemetry --partitions 3
fluvio topic create device-status --partitions 1
```

#### 2. Start MQTT Broker

```bash
cd ../mqtt
./deploy.sh
```

#### 3. Build and Run Go Bridge

```bash
cd services/mqtt-fluvio-bridge

# Install dependencies
go mod download

# Build
go build -o mqtt-fluvio-bridge ./cmd

# Run
./mqtt-fluvio-bridge -config config/config.yaml
```

#### 4. Run Python Consumers

```bash
cd services/fluvio-consumers

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run database consumer
python database/consumer.py

# Run analytics consumer (in another terminal)
python analytics/consumer.py
```

## Configuration

### MQTT Bridge Configuration

Edit `mqtt-fluvio-bridge/config/config.yaml`:

```yaml
mqtt:
  broker_url: "ssl://localhost:8883"
  topics:
    - "vpp/telemetry/+"
  use_tls: true

stream:
  transport: "kafka"          # or "fluvio"
  default_topic: "telemetry.raw"

kafka:
  brokers: ["localhost:9092"]
  required_acks: "all"
  topics:
    "vpp/telemetry/+": "telemetry.raw"

fluvio:
  endpoint: "localhost:9003"
  cli_path: "fluvio"
  topics:
    "vpp/telemetry/+": "telemetry"

bridge:
  worker_count: 4
  buffer_size: 1000
  enable_validation: true
```

#### Stream transports

The bridge publishes through one of two transports, selected by
`stream.transport` (or the `STREAM_TRANSPORT` env var):

| Transport | Client | Notes |
| --- | --- | --- |
| `kafka` | `segmentio/kafka-go` (pure Go) | Publishes to the same brokers/topics as the Node services (`server/integration/kafka-config.ts`). Writes are synchronous and acknowledged; `required_acks: none` is rejected. Supports TLS and SASL PLAIN/SCRAM. |
| `fluvio` | the `fluvio` CLI | InfinyOn publishes no Go SDK, so records are produced via `fluvio produce`. The CLI must be installed in the runtime image and its active profile must match `fluvio.profile` (the CLI has no per-command profile flag). |

Both transports fail loudly: an invalid transport or an unreachable/missing
topic stops the bridge at startup, and a publish that is not acknowledged returns
an error instead of being silently dropped. Set `create_missing_topics: true` to
let the bridge create mapped topics itself.

### Python Consumers Configuration

Set environment variables:

```bash
# Database Consumer
export FLUVIO_TOPIC=telemetry
export DB_HOST=localhost
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD=your_password
export DB_NAME=vpp

# Analytics Consumer
export WINDOW_SIZE_SECONDS=60
```

## Testing

### Send Test Message

```bash
# Install MQTT client
pip install paho-mqtt

# Send test telemetry
python << EOF
import paho.mqtt.client as mqtt
import json
import time

client = mqtt.Client()
client.connect("localhost", 1883)

data = {
    "device_id": "test-device-001",
    "asset_id": 1,
    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "power": 1500.0,
    "energy": 1200.0,
    "voltage": 230.0,
    "current": 6.5,
    "frequency": 50.0,
    "power_factor": 0.95,
    "battery_level": 75.0
}

client.publish("vpp/telemetry/test-device-001", json.dumps(data))
client.disconnect()
print("Message sent")
EOF
```

### Monitor Fluvio Topics

```bash
# Consume from telemetry topic
fluvio consume telemetry --from-beginning
```

## Performance Tuning

### Go Bridge

- **worker_count**: Number of parallel workers (default: 4)
  - Increase for higher throughput
  - Set to number of CPU cores

- **buffer_size**: Message channel buffer (default: 1000)
  - Increase if seeing "channel full" warnings
  - Higher values use more memory

### Fluvio

- **Partitions**: Increase for parallel processing
  ```bash
  fluvio topic create telemetry --partitions 10
  ```

- **Replication**: Set for fault tolerance
  ```bash
  fluvio topic create telemetry --replication 3
  ```

### Python Consumers

- **Multiple Instances**: Run multiple consumer instances
  - Each consumes from different partitions
  - Automatic load balancing

## Monitoring

### Health Checks

```bash
# Check bridge status
docker-compose logs mqtt-fluvio-bridge | tail -20

# Check consumer status
docker-compose logs database-consumer | tail -20
docker-compose logs analytics-consumer | tail -20
```

### Metrics

- **MQTT Broker**: `http://localhost:18083` (if management plugin enabled)
- **Fluvio**: `fluvio topic list`, `fluvio partition list`

## Troubleshooting

### Bridge Not Connecting to MQTT

1. Check MQTT broker is running: `docker-compose ps mosquitto`
2. Verify TLS certificates are correct
3. Check credentials in config.yaml

### Consumer Not Receiving Messages

1. Verify Fluvio topic exists: `fluvio topic list`
2. Check consumer logs: `docker-compose logs database-consumer`
3. Test Fluvio directly: `fluvio consume telemetry`

### High Memory Usage

1. Reduce `buffer_size` in bridge config
2. Decrease `WINDOW_SIZE_SECONDS` in analytics consumer
3. Add more consumer instances to distribute load

## Production Deployment

### Systemd Services

Create systemd service files for each component:

```bash
# /etc/systemd/system/mqtt-fluvio-bridge.service
[Unit]
Description=MQTT-Fluvio Bridge
After=network.target

[Service]
Type=simple
User=vpp
WorkingDirectory=/opt/vpp/mqtt-fluvio-bridge
ExecStart=/opt/vpp/mqtt-fluvio-bridge/mqtt-fluvio-bridge -config config/config.yaml
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable mqtt-fluvio-bridge
sudo systemctl start mqtt-fluvio-bridge
```

### Kubernetes Deployment

See `k8s/` directory for Kubernetes manifests.

## Security

- **MQTT**: Always use TLS (port 8883) in production
- **Fluvio**: Enable authentication and encryption
- **Secrets**: Use environment variables, never commit credentials

## License

MIT

## Support

For issues and questions, please open a GitHub issue or contact the VPP team.
