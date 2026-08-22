# Grid protocols (layer 2)

Real network implementations of the protocols the platform needs to speak to
hardware and to utilities. Nothing here decides anything: authorization,
transactions and demand-response participation are decided by the VPP server,
which this service calls over an authenticated internal API.

| Protocol | Role | Transport | Package |
| --- | --- | --- | --- |
| OCPP 1.6J | Central system | JSON over WebSocket (`ocpp1.6` subprotocol) | `internal/ocpp16` |
| OpenADR 2.0b | VEN (simple HTTP pull) | XML over HTTP(S) | `internal/openadr` |
| IEEE 2030.5 (SEP2) | Client | XML over HTTPS with mutual TLS | `internal/sep2` |
| Modbus TCP/RTU | Poller | see `services/modbus-poller` (Rust) | — |

## What it refuses to do

* Accept a charge point that did not authenticate (basic auth, security
  profile 1) or that does not offer the `ocpp1.6` subprotocol.
* Answer `Authorize`, `StartTransaction` or `StopTransaction` on its own — the
  platform answers, and a platform failure becomes an OCPP `CALLERROR`.
* Report a command as applied when the charge point answered `Rejected` or did
  not answer at all: an OCPP timeout is surfaced as unconfirmed delivery.
* Claim OpenADR participation without a platform decision. Poll failures,
  malformed XML and unknown payload types are errors, never "no event", and an
  event the platform cannot serve is answered with `optOut`.
* Start with a half-configured protocol, a platform secret shorter than 32
  characters, a plain-HTTP SEP2 endpoint or without client certificates.

## Internal API authentication

Both directions are signed with HMAC-SHA256 over `"<unix timestamp>.<body>"`
using `GRID_PROTOCOL_SHARED_SECRET`, sent as `x-grid-timestamp` and
`x-grid-signature`. Signatures older than five minutes are rejected on both
sides. Inbound protocol traffic goes to `POST /api/grid/*` on the server;
outbound commands come from the server to `POST /admin/*` here.

## Running

```sh
cp config.example.yaml config.yaml   # then fill in secrets via the environment
go run ./cmd/gridd -config config.yaml
```

Verification:

```sh
go test ./... && go vet ./... && go build ./...
```

## Not yet proven

The test suite covers framing, correlation, timeouts, registration, event
parsing, TLS and LFDI derivation against in-process servers. Interoperability
with a real charge point, a utility VTN or a 2030.5 server has not been
exercised; treat certification as outstanding.
