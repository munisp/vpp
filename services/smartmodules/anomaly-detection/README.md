# anomaly-detection

Fluvio SmartModule (WASM guest) that filters a telemetry stream down to records
that breach thresholds (power, voltage, frequency, power factor, battery) and
emits them as `AnomalyAlert` JSON.

## Trace context propagation (honest model)

SmartModules run inside the Fluvio SPU as WASM guests: there is no socket, no
tokio runtime, and no way to open an OTLP exporter connection. This module
therefore does **no in-guest telemetry** — instead it carries W3C trace context
through the record payload:

1. The producer (`mqtt-fluvio-bridge`) stamps a `traceparent` field (W3C trace
   context) into each telemetry record it publishes.
2. This module **copies `traceparent`** from the incoming record into every
   `AnomalyAlert` it emits, so an alert joins the same distributed trace as the
   reading that caused it. Records without the field produce alerts without it
   (the key is omitted, never `null`).
3. Downstream consumers extract the field and continue the trace.

The schema stays compatible: `traceparent` is optional on input
(`#[serde(default)]`) and omitted on output when absent
(`skip_serializing_if`).

## Verification

```sh
cargo test                                        # host unit tests
cargo check --release --target wasm32-wasip1      # WASM guest build
```
