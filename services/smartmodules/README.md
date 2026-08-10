# Fluvio SmartModules for VPP Platform

Stream processing modules written in Rust and compiled to WebAssembly (WASM).

## Overview

SmartModules run inside the Fluvio cluster and process data streams in real-time before delivery to consumers. This enables:

- **Data enrichment** - Add calculated fields and metadata
- **Filtering** - Remove invalid or irrelevant records
- **Transformation** - Convert data formats
- **Anomaly detection** - Identify outliers and trigger alerts

## Available SmartModules

### 1. Telemetry Enrichment (`enrichment/`)

Enriches raw telemetry data with calculated metrics and status indicators.

**Input:**
```json
{
  "device_id": "device-001",
  "asset_id": 1,
  "power": 1500.0,
  "voltage": 230.0,
  "current": 6.5,
  "power_factor": 0.95,
  "battery_level": 75.0
}
```

**Output:**
```json
{
  ...original fields...,
  "power_kw": 1.5,
  "apparent_power": 1495.0,
  "reactive_power": 466.8,
  "power_quality": "excellent",
  "voltage_status": "normal",
  "frequency_status": "normal",
  "battery_status": "medium"
}
```

### 2. Anomaly Detection (`anomaly-detection/`)

Filters telemetry stream to only pass through records with detected anomalies.

**Detects:**
- High power consumption (>5000W)
- Voltage out of range (210-250V)
- Frequency deviation (49-51Hz)
- Low power factor (<0.70)
- Critical battery level (<15%)

**Output:**
```json
{
  "device_id": "device-001",
  "anomaly_type": "low_voltage",
  "severity": "warning",
  "message": "Voltage below safe threshold: 205.3V",
  "value": 205.3,
  "threshold": 210.0
}
```

### 3. Alert Filter (`alert-filter/`)

Filters anomaly stream to only critical alerts for notification delivery.

## Building SmartModules

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add WASM target
rustup target add wasm32-unknown-unknown

# Install Fluvio CLI
curl -fsS https://hub.infinyon.cloud/install/install.sh | bash
```

### Build

```bash
# Build enrichment module
cd enrichment
cargo build --release --target wasm32-unknown-unknown

# Build anomaly detection module
cd ../anomaly-detection
cargo build --release --target wasm32-unknown-unknown
```

The compiled WASM files will be in `target/wasm32-unknown-unknown/release/*.wasm`.

## Deploying SmartModules

### 1. Create SmartModule in Fluvio

```bash
# Create enrichment SmartModule
fluvio smartmodule create telemetry-enrichment \
  --wasm-file enrichment/target/wasm32-unknown-unknown/release/telemetry_enrichment.wasm

# Create anomaly detection SmartModule
fluvio smartmodule create anomaly-detection \
  --wasm-file anomaly-detection/target/wasm32-unknown-unknown/release/anomaly_detection.wasm
```

### 2. List SmartModules

```bash
fluvio smartmodule list
```

### 3. Use SmartModules

#### Option A: Apply to Consumer

```bash
# Consume with enrichment
fluvio consume telemetry --smartmodule telemetry-enrichment

# Consume only anomalies
fluvio consume telemetry --smartmodule anomaly-detection
```

#### Option B: Create Derived Topic

```bash
# Create enriched telemetry topic
fluvio topic create telemetry-enriched

# Create consumer that applies SmartModule and produces to new topic
# (This requires a separate consumer application)
```

#### Option C: Apply in Python Consumer

```python
from fluvio import Fluvio, Offset

fluvio = Fluvio.connect()
consumer = fluvio.partition_consumer("telemetry", 0)

# Consume with SmartModule
stream = consumer.stream_with_config(
    Offset.end(),
    smartmodule="telemetry-enrichment"
)

for record in stream:
    enriched_data = json.loads(record.value())
    # Process enriched data
```

## Development

### Testing Locally

```bash
# Test enrichment module
echo '{"device_id":"test","asset_id":1,"power":1500,"voltage":230,"current":6.5,"frequency":50,"power_factor":0.95,"battery_level":75}' | \
  fluvio produce telemetry

fluvio consume telemetry --smartmodule telemetry-enrichment --from-beginning
```

### Debugging

```bash
# View SmartModule logs
fluvio smartmodule logs telemetry-enrichment

# Delete and recreate
fluvio smartmodule delete telemetry-enrichment
fluvio smartmodule create telemetry-enrichment --wasm-file ...
```

## Performance

- **Enrichment**: ~50μs per record
- **Anomaly Detection**: ~30μs per record
- **Memory**: <1MB per SmartModule

SmartModules run in the Fluvio cluster, not in consumers, so they scale horizontally with the cluster.

## Best Practices

1. **Keep modules small** - Each should do one thing well
2. **Avoid external dependencies** - WASM has limited support
3. **Use efficient algorithms** - Modules run on every record
4. **Test thoroughly** - Errors in SmartModules affect all consumers
5. **Version your modules** - Use semantic versioning

## Troubleshooting

### Module won't load
- Check WASM target: `rustup target list --installed`
- Verify file path is correct
- Check Fluvio cluster is running

### Module crashes
- Add error handling in Rust code
- Test with various input formats
- Check for panics in module code

### Poor performance
- Profile with `cargo flamegraph`
- Reduce allocations
- Use `opt-level = 's'` in Cargo.toml

## Resources

- [Fluvio SmartModule Documentation](https://www.fluvio.io/smartmodules/)
- [Rust WebAssembly Book](https://rustwasm.github.io/docs/book/)
- [Fluvio Examples](https://github.com/infinyon/fluvio/tree/master/smartmodule)
