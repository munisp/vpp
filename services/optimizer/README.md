# Dispatch optimizer service

Mixed-integer dispatch optimization for the VPP platform: deterministic MILP,
two-stage stochastic programming with CVaR, rolling-horizon MPC, and multi-site
coordination. The TypeScript server calls it over HTTP through
`server/services/milp-dispatch.ts`.

It replaces the per-asset, per-interval rule engine in
`server/services/optimization-engine.ts`, which could not respect state of charge
over a horizon, grid limits, or charge/discharge exclusivity, yet labelled its
output `optimized`.

## No plausible-looking output

Every failure mode is explicit; none of them produce a schedule:

| Situation | Result |
| --- | --- |
| No MILP solver installed | `503`, `SolverUnavailable` — never an approximated schedule |
| Infeasible / unbounded model | `422` with `status: infeasible` / `unbounded`, empty `intervals` |
| Solver hits its time limit without proving optimality | `422` with `status: not_solved` |
| Multi-site coordination fails to converge | `422` with `status: not_converged`, plus the worst shared-limit violation |
| `minimize_emissions` without an emissions forecast | request rejected; no assumed carbon intensity |
| `balance_grid` without a grid target | request rejected |
| Missing `OPTIMIZER_AUTH_TOKEN` in production | service refuses to start |

The client mirrors this: `solveMilpDispatch()` throws unless the solver proved
optimality, and in production a missing `OPTIMIZER_SERVICE_URL` fails closed
instead of falling back to the rule engine.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness, the list of discovered solvers, and the telemetry status |
| `GET` | `/metrics` | Prometheus scrape endpoint |
| `POST` | `/optimize/dispatch` | Deterministic MILP over the horizon |
| `POST` | `/optimize/stochastic` | Two-stage stochastic program, optional CVaR |
| `POST` | `/optimize/mpc` | Rolling horizon, applying only the first interval per step |
| `POST` | `/optimize/coordinate` | Multi-site coordination under shared grid limits |

Authentication is the `x-optimizer-token` header, compared against
`OPTIMIZER_AUTH_TOKEN`.

## Telemetry

Traces and metrics are OpenTelemetry, governed by the shared env contract:

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP gRPC endpoint (e.g. `http://otel-collector:4317`). **Unset = telemetry disabled**: the service logs `telemetry disabled: <reason>` at startup and runs fine without it. |
| `OTEL_SDK_DISABLED` | `true` disables the SDK entirely (escape hatch). |
| `OTEL_SERVICE_NAME` / `OTEL_SERVICE_VERSION` / `OTEL_ENVIRONMENT` | Resource attributes; service name defaults to `optimizer`. |
| `OTEL_TENANT_ID` | `tenant.id` resource attribute (default `default`), exported as the `tenant_id` label by the collector. |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | Defaults to `http` (set by the service if unset) so the FastAPI instrumentor emits the stable `http.server.request.duration` metric (seconds), which the collector's Prometheus exporter serves as `http_server_request_duration_seconds_*`. |

The FastAPI instrumentor extracts W3C `traceparent`/`tracestate` from incoming
requests, so traces started by the TypeScript caller continue here. Each solve
endpoint wraps its work in a `pulp.solve` child span (solver, variable and
constraint counts, status, objective). Collector unavailability never crashes
the service: export failures are logged and dropped. `/health` reports
`telemetry: {enabled, reason?}`; `/metrics` serves Prometheus text
(`optimizer_http_requests_total`, `optimizer_solve_duration_seconds`).

## Units

API boundary: power in watts, energy in watt-hours, prices in cents/kWh, carbon
in gCO2e/kWh, money in cents. Internally the models work in kW/kWh/cents.
Positive asset power means export/discharge/generation; negative means
import/charge/consumption.

## Model

Per interval `t`, with all battery/generation/flexible-load terms summed:

```
Σ discharge + Σ generation + import == load - shed + Σ charge + export + unserved
```

Batteries carry `soc[t+1] = soc[t] + charge·η_c·Δt - discharge/η_d·Δt`, with
binary exclusivity on charge/discharge and on grid import/export, optional
terminal SoC, and a per-kWh cycle cost. Shedding and unserved load are priced,
so the solver only uses them when they are genuinely cheaper than the
alternative.

Stochastic solves put every scenario in one MILP, tie first-stage decisions
across scenarios (non-anticipativity), and optimize
`(1-λ)·E[cost] + λ·CVaR_α`, with CVaR in Rockafellar–Uryasev form
`η + 1/(1-α)·Σ p_s·z_s`, `z_s ≥ cost_s - η`, `z_s ≥ 0`.

Coordination is dual decomposition with subgradient multiplier updates on the
shared import/export limits — not ADMM: PuLP's LP formulation cannot express the
quadratic proximal term ADMM requires. Site subproblems stay independent MILPs
and the response reports iterations, shadow prices, the maximum violation, and
whether it converged.

## Running

```bash
pip install -r requirements.txt
uvicorn optimizer.service:app --port 8000

# or
docker build -t vpp-optimizer . && docker run -p 8000:8000 \
  -e OPTIMIZER_AUTH_TOKEN=... vpp-optimizer
```

Server-side configuration: `OPTIMIZER_SERVICE_URL`, `OPTIMIZER_AUTH_TOKEN`, and
optionally `OPTIMIZER_SOLVER` to pin a specific installed solver.

## Tests and benchmarks

```bash
pip install -r requirements-dev.txt
python -m pytest              # 47 tests
python -m benchmarks.run      # reproducible, fixed seed
```

The benchmark scores the MILP and the old threshold heuristic with identical cost
accounting on seeded instances (24/48/96 h, 1 and 3 batteries, PV). Measured on
CBC/HiGHS, the MILP is 1.6–7.3% cheaper and 96 h with 3 batteries solves in under
200 ms. It exits non-zero if any instance fails to solve or the heuristic wins.

## Known gaps

- Not yet load-tested or deployed; no live-endpoint integration test exists.
- Coordination convergence is not guaranteed for arbitrary shared-limit
  topologies; non-convergence is reported, not worked around.
- Forecast inputs come from the caller. Forecast quality is a later layer.
