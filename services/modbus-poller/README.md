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
