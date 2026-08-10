# IoT Data Pipeline Architecture

This document describes the VPP platform's IoT data ingestion and processing pipeline, including integration options for high-performance streaming platforms like Fluvio.

## Current Architecture

### 1. MQTT Broker (Mosquitto)
- **Purpose**: Primary ingestion point for IoT device telemetry
- **Location**: `mqtt/` directory
- **Configuration**: `mqtt/mosquitto.conf`
- **Topics**:
  - `vpp/telemetry/{deviceId}` - Real-time telemetry data
  - `vpp/commands/{deviceId}` - Device commands
  - `vpp/status/{deviceId}` - Device status updates

### 2. MQTT Service (`server/_core/mqtt.ts`)
- Subscribes to MQTT topics
- Validates incoming telemetry data
- Stores data in MySQL/TiDB database
- Broadcasts real-time updates via WebSocket

### 3. WebSocket Service (`server/_core/websocket.ts`)
- Streams real-time telemetry to connected web clients
- Provides live dashboard updates
- Handles user-specific data filtering

### 4. Database Layer
- **Tables**: `telemetry`, `devices`, `device_logs`
- **Purpose**: Persistent storage and historical queries
- **Performance**: Indexed by `assetId`, `timestamp`

## Data Flow

```
IoT Device → MQTT Broker → MQTT Service → Database
                                ↓
                          WebSocket Service → Web Clients
```

## Integration with Fluvio (Optional Enhancement)

Fluvio is a high-performance, distributed streaming platform that can enhance the VPP platform's data processing capabilities.

### Why Fluvio?

1. **High Throughput**: Handle millions of messages per second
2. **Low Latency**: Sub-millisecond message delivery
3. **Stream Processing**: Built-in data transformation and aggregation
4. **Scalability**: Horizontal scaling for growing IoT deployments
5. **Durability**: Persistent message storage with replication

### Architecture with Fluvio

```
IoT Device → MQTT Broker → Fluvio Producer → Fluvio Topics
                                                    ↓
                                            Fluvio Consumers
                                                    ↓
                                    ┌───────────────┴───────────────┐
                                    ↓                               ↓
                              Database Storage              Real-time Analytics
                                    ↓                               ↓
                            WebSocket Service                  Dashboards
```

### Implementation Steps

#### 1. Install Fluvio Cluster

```bash
# Install Fluvio CLI
curl -fsS https://hub.infinyon.cloud/install/install.sh | bash

# Start local Fluvio cluster
fluvio cluster start

# Or connect to existing cluster
fluvio profile add production --cluster <cluster-endpoint>
```

#### 2. Create Fluvio Topics

```bash
# Create telemetry topic with 3 partitions
fluvio topic create vpp-telemetry --partitions 3 --retention-time 7d

# Create commands topic
fluvio topic create vpp-commands --partitions 1 --retention-time 1d

# Create events topic
fluvio topic create vpp-events --partitions 2 --retention-time 30d
```

#### 3. MQTT-Fluvio Bridge

Create a bridge service that forwards MQTT messages to Fluvio:

```typescript
// server/_core/mqtt-fluvio-bridge.ts
import mqtt from 'mqtt';
import Fluvio from '@fluvio/client';

export async function startMqttFluvioBridge() {
  const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL);
  const fluvio = await Fluvio.connect(process.env.FLUVIO_ENDPOINT);
  const producer = await fluvio.topicProducer('vpp-telemetry');

  mqttClient.subscribe('vpp/telemetry/+');

  mqttClient.on('message', async (topic, message) => {
    const deviceId = topic.split('/')[2];
    await producer.send(deviceId, message.toString());
  });
}
```

#### 4. Fluvio Consumer for Database Storage

```typescript
// server/_core/fluvio-consumer.ts
import Fluvio from '@fluvio/client';
import { createTelemetry } from '../db';

export async function startFluvioConsumer() {
  const fluvio = await Fluvio.connect(process.env.FLUVIO_ENDPOINT);
  const consumer = await fluvio.partitionConsumer('vpp-telemetry', 0);

  await consumer.stream({ maxBytes: 10000 }, async (record) => {
    const data = JSON.parse(record.valueString());
    await createTelemetry(data);
  });
}
```

#### 5. Stream Processing with SmartModules

Fluvio supports SmartModules for real-time data transformation:

```rust
// smartmodules/telemetry-aggregator.rs
use fluvio_smartmodule::{smartmodule, Record, RecordData, Result};

#[smartmodule(aggregate)]
pub fn aggregate(accumulator: RecordData, current: &Record) -> Result<RecordData> {
    // Aggregate telemetry data (e.g., calculate averages)
    let data: TelemetryData = serde_json::from_slice(current.value.as_ref())?;
    
    // Perform aggregation logic
    let result = calculate_averages(accumulator, data);
    
    Ok(serde_json::to_vec(&result)?.into())
}
```

### Configuration

Add Fluvio configuration to environment variables:

```env
# Fluvio Configuration
FLUVIO_ENDPOINT=localhost:9003
FLUVIO_PROFILE=production

# Enable Fluvio integration
ENABLE_FLUVIO=true
```

### Benefits of Fluvio Integration

1. **Decoupling**: MQTT and database are decoupled via Fluvio
2. **Replay**: Can replay historical data for analytics
3. **Multiple Consumers**: Multiple services can consume the same stream
4. **Backpressure Handling**: Fluvio handles backpressure automatically
5. **Data Transformation**: SmartModules enable real-time processing

### Monitoring

Monitor Fluvio cluster health:

```bash
# Check cluster status
fluvio cluster status

# Monitor topic metrics
fluvio topic describe vpp-telemetry

# View consumer lag
fluvio consumer list
```

## Alternative: Apache Kafka

If Fluvio is not suitable, Apache Kafka is another excellent option:

```bash
# Start Kafka with Docker
docker-compose up -d kafka zookeeper

# Create topics
kafka-topics --create --topic vpp-telemetry --bootstrap-server localhost:9092
```

## Performance Optimization

### Current System (MQTT + Database)
- **Throughput**: ~10,000 messages/second
- **Latency**: 50-100ms
- **Storage**: MySQL/TiDB

### With Fluvio
- **Throughput**: 1,000,000+ messages/second
- **Latency**: <10ms
- **Storage**: Fluvio (persistent) + MySQL (aggregated)

### With Kafka
- **Throughput**: 100,000+ messages/second
- **Latency**: 10-50ms
- **Storage**: Kafka (persistent) + MySQL (aggregated)

## Recommendations

1. **Small Deployments (<1000 devices)**: Use current MQTT + Database architecture
2. **Medium Deployments (1000-10000 devices)**: Add Fluvio for stream processing
3. **Large Deployments (>10000 devices)**: Use Fluvio or Kafka with SmartModules

## Next Steps

1. Evaluate device count and data volume requirements
2. Choose streaming platform (Fluvio, Kafka, or none)
3. Implement MQTT-to-streaming bridge if needed
4. Deploy consumers for database storage and analytics
5. Monitor performance and scale horizontally as needed

## Resources

- [Fluvio Documentation](https://fluvio.io/docs/)
- [MQTT Best Practices](https://www.hivemq.com/mqtt-essentials/)
- [Apache Kafka Documentation](https://kafka.apache.org/documentation/)
