# telemetry-enrichment

Fluvio SmartModule (WASM guest) that enriches raw telemetry records with
derived metrics (`power_kw`, `energy_kwh`, apparent/reactive power) and quality
classifications.

## Trace context propagation (honest model)

SmartModules run inside the Fluvio SPU as WASM guests: there is no socket, no
tokio runtime, and no way to open an OTLP exporter connection. This module
therefore does **no in-guest telemetry** — instead it carries W3C trace context
through the record payload:

1. The producer (`mqtt-fluvio-bridge`) stamps a `traceparent` field (W3C trace
   context) into each telemetry record it publishes.
2. This module **preserves `traceparent` verbatim**: if the incoming record
   has one, the `EnrichedTelemetry` output carries the identical value; if not,
   the field is absent (never serialized as `null`) and the record is enriched
   unchanged.
3. Downstream consumers extract the field and continue the trace.

The schema stays compatible: `traceparent` is optional on input
(`#[serde(default)]`) and omitted on output when absent
(`skip_serializing_if`), so records produced before trace propagation existed
flow through untouched.

## Verification

```sh
cargo test                                        # host unit tests
cargo check --release --target wasm32-wasip1      # WASM guest build
```
