# IoT Device Integration Guide

This document describes how to integrate smart meters, inverters, and other IoT devices with the VPP Consumer Platform.

## Architecture

The platform uses MQTT (Message Queuing Telemetry Transport) for real-time communication with IoT devices. MQTT is lightweight, reliable, and ideal for IoT applications with limited bandwidth.

### Components

1. **MQTT Broker** - Central message broker (Mosquitto recommended)
2. **MQTT Service** - Server-side service that handles device messages
3. **Device Registry** - Database of registered devices
4. **Telemetry Storage** - Time-series data storage for device metrics

## Topic Structure

All MQTT topics follow this pattern:

```
vpp/{userId}/{assetId}/{messageType}
```

### Message Types

- `telemetry` - Real-time sensor data from devices
- `status` - Device health and status updates
- `command/{commandName}` - Commands sent to devices

### Examples

```
vpp/123/456/telemetry        # Telemetry from asset 456 owned by user 123
vpp/123/456/status           # Status update from asset 456
vpp/123/456/command/reset    # Reset command to asset 456
```

## Message Formats

### Telemetry Message

Devices should publish telemetry data in JSON format:

```json
{
  "deviceId": "SM-12345",
  "timestamp": 1704067200000,
  "power": 5000,
  "energy": 125000,
  "voltage": 230000,
  "current": 21739,
  "frequency": 50000,
  "stateOfCharge": 8500,
  "temperature": 2500,
  "metadata": {
    "signal_strength": -65,
    "battery_health": "good"
  }
}
```

**Field Units:**
- `power` - Watts (W)
- `energy` - Watt-hours (Wh) cumulative
- `voltage` - Millivolts (mV)
- `current` - Milliamps (mA)
- `frequency` - Millihertz (mHz)
- `stateOfCharge` - Percentage * 100 (e.g., 8500 = 85%)
- `temperature` - Celsius * 100 (e.g., 2500 = 25°C)

### Status Message

```json
{
  "deviceId": "SM-12345",
  "timestamp": 1704067200000,
  "metadata": {
    "status": "active",
    "uptime": 86400,
    "firmware_version": "1.2.3"
  }
}
```

### Command Message

Commands are published by the server to devices:

```json
{
  "commandId": "cmd-789",
  "timestamp": 1704067200000,
  "parameters": {
    "interval": 10
  }
}
```

## Device Authentication

Devices authenticate using MQTT username/password credentials:

1. Register device in admin dashboard
2. System generates unique credentials
3. Configure device with:
   - MQTT broker URL
   - Username (device ID)
   - Password (generated token)

## Supported Device Types

### Smart Meters

Measure energy consumption and generation:

- Real-time power (W)
- Cumulative energy (Wh)
- Voltage, current, frequency
- Power factor

### Inverters

Convert DC from solar panels to AC:

- DC input voltage/current
- AC output voltage/current/frequency
- Conversion efficiency
- Temperature

### Battery Controllers

Manage battery charging/discharging:

- State of charge (%)
- Charge/discharge power
- Battery voltage/current
- Temperature
- Cycle count

### Sensors

Environmental and system sensors:

- Temperature
- Humidity
- Irradiance (for solar)
- Wind speed (for wind turbines)

## Integration Steps

### 1. Set Up MQTT Broker

Install Mosquitto (recommended):

```bash
# Ubuntu/Debian
sudo apt-get install mosquitto mosquitto-clients

# Configure authentication
sudo mosquitto_passwd -c /etc/mosquitto/passwd vpp-admin

# Start broker
sudo systemctl start mosquitto
sudo systemctl enable mosquitto
```

### 2. Configure Environment Variables

Add to `.env`:

```env
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_USERNAME=vpp-admin
MQTT_PASSWORD=your-secure-password
```

### 3. Register Device

Use admin dashboard or API:

```typescript
// Register device via tRPC
const device = await trpc.admin.registerDevice.mutate({
  assetId: 123,
  deviceId: "SM-12345",
  deviceType: "smart_meter",
  manufacturer: "Acme Corp",
  model: "SM-1000",
});
```

### 4. Configure Device

Program your device with:

- Broker URL: `mqtt://your-server.com:1883`
- Client ID: Generated device ID
- Username: From device registration
- Password: From device registration
- Publish topic: `vpp/{userId}/{assetId}/telemetry`
- QoS: 1 (at least once delivery)

### 5. Test Connection

Use MQTT client to test:

```bash
# Subscribe to telemetry
mosquitto_sub -h localhost -t "vpp/+/+/telemetry" -u vpp-admin -P password

# Publish test message
mosquitto_pub -h localhost -t "vpp/123/456/telemetry" \
  -u vpp-admin -P password \
  -m '{"deviceId":"SM-12345","timestamp":1704067200000,"power":5000}'
```

## Device Commands

### Available Commands

- `reset` - Restart device
- `update_interval` - Change telemetry reporting interval
- `calibrate` - Run calibration routine
- `firmware_update` - Trigger OTA firmware update

### Sending Commands

```typescript
await mqttService.publishCommand(userId, assetId, 'update_interval', {
  interval: 10 // seconds
});
```

## Monitoring and Troubleshooting

### Device Status

Check device status in admin dashboard:
- Online/Offline status
- Last seen timestamp
- Message count
- Error logs

### Common Issues

**Device Not Connecting:**
- Verify broker URL and port
- Check credentials
- Ensure firewall allows MQTT traffic (port 1883)

**No Telemetry Data:**
- Verify topic structure
- Check device logs
- Ensure device has correct asset ID

**High Latency:**
- Check network connection
- Reduce telemetry interval
- Use QoS 0 for non-critical data

## Security Best Practices

1. **Use TLS/SSL** - Enable MQTTS (port 8883) for encrypted communication
2. **Unique Credentials** - Each device gets unique username/password
3. **Access Control** - Devices can only publish to their own topics
4. **Regular Updates** - Keep firmware and broker software updated
5. **Monitor Activity** - Log and alert on suspicious patterns

## Example Device Implementation

### Arduino/ESP32

```cpp
#include <WiFi.h>
#include <PubSubClient.h>

const char* mqtt_server = "mqtt.example.com";
const char* mqtt_user = "device-12345";
const char* mqtt_pass = "secure-token";
const char* topic = "vpp/123/456/telemetry";

WiFiClient espClient;
PubSubClient client(espClient);

void setup() {
  client.setServer(mqtt_server, 1883);
  client.connect("ESP32Client", mqtt_user, mqtt_pass);
}

void loop() {
  if (!client.connected()) {
    reconnect();
  }
  
  // Read sensor data
  float power = readPower();
  float voltage = readVoltage();
  
  // Create JSON message
  String payload = "{";
  payload += "\"deviceId\":\"SM-12345\",";
  payload += "\"timestamp\":" + String(millis()) + ",";
  payload += "\"power\":" + String((int)power) + ",";
  payload += "\"voltage\":" + String((int)(voltage * 1000));
  payload += "}";
  
  // Publish
  client.publish(topic, payload.c_str());
  
  delay(5000); // 5 second interval
}
```

### Python

```python
import paho.mqtt.client as mqtt
import json
import time

broker = "mqtt.example.com"
port = 1883
topic = "vpp/123/456/telemetry"
username = "device-12345"
password = "secure-token"

client = mqtt.Client()
client.username_pw_set(username, password)
client.connect(broker, port)

while True:
    # Read sensor data
    power = read_power()
    voltage = read_voltage()
    
    # Create message
    message = {
        "deviceId": "SM-12345",
        "timestamp": int(time.time() * 1000),
        "power": int(power),
        "voltage": int(voltage * 1000)
    }
    
    # Publish
    client.publish(topic, json.dumps(message), qos=1)
    
    time.sleep(5)
```

## Support

For device integration support:
- Check device logs in admin dashboard
- Review MQTT broker logs
- Contact platform support with device ID and error messages
