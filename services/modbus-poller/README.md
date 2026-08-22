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

## Running

```sh
cp config.example.toml config.toml   # secrets come from the environment
cargo run --release -- config.toml
```

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
