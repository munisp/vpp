# VPP platform

An open source virtual power plant platform: it registers distributed energy resources, forecasts
and optimizes their dispatch, controls them over the protocols the devices actually speak, trades
and settles the energy on a double-entry ledger, and reports what happened with the evidence behind
every figure.

It is built for the deployments where the numbers have consequences — a rural microgrid whose
customers prepay for energy, a utility that needs a feeder check before it accepts an award, a
development-finance lender who needs to know how a site really performed.

## The design rule

**The platform never claims what it has not established.** When the evidence is missing — no
telemetry, no credentials, no converged solve, no provider response — it refuses, or returns null
with a stated reason. It does not return a plausible-looking default.

That is not a slogan; it is enforced in the schema and the tests. A study that could not be solved
cannot carry a recommendation. A metric below its coverage floor prints "insufficient data", not 0.
A payment with no configured gateway reports unavailable, not success. A silent metering interval is
a silent meter, not zero demand.

## What it does

**Assets and telemetry** — DER registry with nameplate and capability data, rolling fleet telemetry
aggregates that publish their own coverage, digital twin and a NOC/SOC wall built only from
telemetry that exists.

**Control** — OCPP 1.6J and 2.0.1 (charge points), OpenADR 2.0b, IEEE 2030.5, Modbus/TCP (Rust
poller with a durable spool), Matter smart-home loads through a real controller. Every setpoint is
bounded, has a validity window and a declared fallback.

**Optimization and forecasting** — MILP dispatch with stochastic/CVaR and MPC modes, PyTorch/GNN
forecast models trained on recorded data, with drift detection and promotion gated on verified
checkpoints.

**Markets** — P2P, B2B and P2B trading with typed counterparties, locational flexibility products
measured at the asset, price signals the fleet can plan against, settlement on evidence only.

**Money** — payment initiation and provider callbacks, TigerBeetle double-entry ledger with
deterministic transfer ids (a replayed callback is a duplicate, not a second movement), independent
reconciliation, prepaid/PAYG vending gated on payment, ledger and key evidence.

**Grid engineering** — pandapower network feasibility and hosting capacity, design studies that cost
a site that does not exist yet, island-autonomy and critical-load resilience from registered
nameplate, and customer-experienced reliability (SAIDI/SAIFI/CAIDI) from recorded interruptions.

**Operations** — Temporal workflows, 20 reusable stakeholder journeys that exercise the platform's
own services end to end, a lakehouse whose runs succeed only when the object reads back with a
matching checksum, local-model diagnostics that refuse to answer without evidence, and a degraded
mode with explicit capability limits.

**Surfaces** — a PWA with grouped navigation and a React Native app, both showing provenance beside
the figure.

## Architecture

```
PWA (React/Vite) ─┐
React Native app ─┴─► API (Node/TypeScript, tRPC) ─► PostgreSQL   (every application fact)
                                │                    TigerBeetle  (ledger movements)
                                │                    Redis        (rate limits, cache)
                                │                    Kafka        (events, via transactional outbox)
                                ├─► Temporal workers (payments, DR, trading, prepaid, journeys)
                                ├─► services/optimizer   (Python: dispatch MILP, design studies)
                                ├─► services/gridmodel   (Python: pandapower power flow)
                                ├─► services/ml          (Python: PyTorch/Ray training)
                                ├─► services/lakehouse   (Python: derived analytics, checksummed)
                                ├─► services/grid-protocols (Go: OCPP/OpenADR/2030.5/Matter)
                                └─► services/modbus-poller  (Rust: Modbus/TCP with a spool)
```

PostgreSQL is the only application data store. The lakehouse is derived and rebuildable; a DSN for
any other store is refused at configuration time.

## Quickstart

Node 20 with pnpm, Python 3.12, Go 1.22, Rust stable, PostgreSQL 16.

```bash
pnpm install
export DATABASE_URL="postgresql://vpp:vpp@127.0.0.1:5432/vpp"
npx drizzle-kit migrate     # ~97 tables
pnpm dev                    # API + PWA
```

Optional dependencies each degrade honestly rather than faking: without Redis the platform refuses
to boot in production unless you accept per-replica limits (`RATE_LIMIT_STORE=memory`); without
TigerBeetle a settlement leaves a visible unposted row; without a payment gateway payments report
unavailable. See `.env.example` for the full set and [DEPLOYMENT.md](DEPLOYMENT.md) for a real
deployment.

Tests: `pnpm test`, plus the per-language suites listed in [CONTRIBUTING.md](CONTRIBUTING.md).

## What is proven, and what needs your side

Verified against live local infrastructure: PostgreSQL, TigerBeetle, Temporal, MQTT, MinIO, a local
Ollama model, the optimizer and gridmodel services, the PWA in a real browser, and the mobile app in
Expo web.

Not proven here, and not claimed: mobile-money and SMS providers (no sandbox credentials), Mojaloop
payout, a production Kafka cluster, production S3, physical OCPP/Matter hardware, real utility meters
and DSO feeds, multi-node Ray, and native-only mobile behaviour (camera/QR, biometrics, push).
Those are integration points, and each one reports blocked rather than passing.

## Project documents

- [LICENSE](LICENSE) — MIT
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, the checks to run, DCO sign-off
- [SECURITY.md](SECURITY.md) — how to report a vulnerability, and the one key this repository leaked
- [GOVERNANCE.md](GOVERNANCE.md) — who decides, and the community/commercial boundary
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [DEPLOYMENT.md](DEPLOYMENT.md), [MIGRATIONS.md](MIGRATIONS.md) — running it and evolving the schema
