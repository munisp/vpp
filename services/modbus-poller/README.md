# Modbus poller

Polls Modbus TCP and RTU devices (inverters, meters, battery controllers) and
publishes decoded readings to the VPP server.

## What it refuses to do

* Poll a register that is not declared, or decode one without an explicit data
  type, word order, scale and unit.
* Turn a failed read, a Modbus exception, a truncated response or a non-finite
  float into a value. Failures are logged and the register is simply absent from
  the batch — a zero would look like a real measurement.
* Publish unsigned: every batch carries an HMAC-SHA256 signature over
  `"<unix timestamp>.<body>"` using `GRID_PROTOCOL_SHARED_SECRET`, and a
  rejected publish is an error rather than a dropped batch.
* Lose a reading because the platform was unreachable, or hide that it did.

## When the platform is unreachable

Readings carry the timestamp of the register read, so delivering them late is
still accurate — dropping them destroys the only record that the meter was read,
which is what settlement is computed from. Undelivered readings are therefore
held in a bounded spool and replayed oldest-first on the next cycle, and stay
there until the platform accepts them.

The spool is bounded (`spool_max_readings`, sent in batches of
`publish_batch_size`). When it fills, the oldest readings are discarded and
counted: `dropped`/`dropped_total` on an error log is a hole in the meter
history, not a quiet device. A spool smaller than one batch is rejected at
startup.

A batch overshoots `publish_batch_size` rather than cut through an instant. The
platform builds one telemetry sample per device per instant from the registers
in a single request, so sending an instant's `active_power` in one request and
its `total_energy` in the next stores that instant as two rows, each with the
other's column empty.

## Running

```sh
cp config.example.toml config.toml   # secrets come from the environment
cargo run --release -- config.toml
```

## Tracing (OpenTelemetry)

The poller keeps its JSON log output (`fmt` layer, `RUST_LOG`/`EnvFilter` as
before) and can additionally export OTLP traces over gRPC. Configuration is
entirely environmental, shared with the rest of the platform rollout:

| Variable | Meaning | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP gRPC (tonic) collector endpoint | **unset → telemetry disabled** |
| `OTEL_SERVICE_NAME` | resource `service.name` | `modbus-poller` |
| `OTEL_SERVICE_VERSION` | resource `service.version` | crate version |
| `OTEL_ENVIRONMENT` | resource `deployment.environment.name` | unset (attribute omitted) |
| `OTEL_TENANT_ID` | resource `tenant.id` | `default` |
| `OTEL_SDK_DISABLED` | `true` disables the SDK outright | unset |

With the endpoint unset (or the escape hatch set) the poller logs
`telemetry disabled: reason ...` once at startup and runs exactly as before.
The exporter connects lazily and batches in the background, so a dead or
flapping collector shows up as export errors in the logs — never as a crash or
a stalled poll cycle.

Each poll cycle is a trace: a `modbus.poll_cycle` root span with a
`modbus.poll_device` child per device (carrying `device.id` and the register
address range) and a `modbus.publish` child per delivered batch. `warn!` /
`error!` events (unreachable device, register failure, spool overflow, rejected
publish) land on the active span.

### Trace propagation

`PlatformClient::publish` injects the current span context as a W3C
`traceparent` header on the HMAC-signed `POST /api/grid/modbus/readings`, so
the server's ingest span joins the edge trace. The header is unsigned metadata
(like `content-type`), not part of the HMAC body. When telemetry is disabled
the context is invalid and no header is sent.

Downstream of the platform the model is payload-level: the MQTT→Fluvio bridge
stamps `traceparent` into each record, the Fluvio SmartModules
(`services/smartmodules/enrichment`, `.../anomaly-detection` — WASM guests that
cannot run an OTLP exporter) preserve it verbatim, and consumers extract it to
continue the trace.

Verification:

```sh
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

## Not yet proven

Tests run against an in-process Modbus TCP server. No physical device or serial
line has been exercised, so RTU timing (baud rate, inter-frame gaps) and vendor
register maps remain unverified.
