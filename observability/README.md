# VPP Platform Observability

Central telemetry backbone: **OTel Collector** in front of **Jaeger** (traces)
and **Prometheus** (metrics), with **Grafana** for visualization and
**Alertmanager** for alert routing.

```
                         ┌────────────────────────────────────────────────┐
                         │                app services                    │
                         │ vpp-server  payment/dr/trading/prepaid-worker  │
                         │ optimizer gridmodel grid-protocols             │
                         │ mqtt-fluvio-bridge  fluvio consumers  permify  │
                         │ browser RUM (client)                           │
                         └───────┬───────────────────┬────────────────────┘
                     OTLP gRPC :4317 │               │ OTLP HTTP :4318 (CORS)
                                     ▼               ▼
                         ┌────────────────────────────────┐
                         │         OTEL COLLECTOR         │  :8888 self-telemetry
                         │  receivers: otlp, prometheus   │  :8889 prometheus exporter
                         │  processors: memory_limiter →  │  :13133 health_check
                         │    resource(tenant.id) → batch │
                         └──┬───────────────┬─────────────┘
              traces (OTLP) │               │ metrics (Prometheus text)
                            ▼               ▼
                      ┌───────────┐   ┌───────────────────────────────────┐
                      │  JAEGER   │   │             PROMETHEUS            │
                      │ UI :16686 │   │  scrapes: collector :8889/:8888,  │
                      └─────┬─────┘   │  app /metrics endpoints, infra    │
                            │         │  exporters, temporal, keycloak,   │
                            │         │  apisix, tigerbeetle-statsd       │
                            │         └───────┬───────────────┬───────────┘
                            │                 │ alerts        │ queries
                            ▼                 ▼               ▼
                      ┌───────────────────────────────────────────────┐
                      │  GRAFANA (:3001)         ALERTMANAGER (:9093) │
                      │  Prometheus + Jaeger     Slack / PagerDuty /  │
                      │  datasources, RED +      DeadMansSwitch       │
                      │  pipeline dashboards     webhook              │
                      └───────────────────────────────────────────────┘

   infra metrics side path:  tigerbeetle --statsd(UDP)--> tigerbeetle-statsd
                             (statsd-exporter) :9102 --> scraped as tb_*
```

## Layout

| Path | What |
|---|---|
| `observability/otel-collector-config.yaml` | Collector config (compose). Validated with `otelcol validate`. |
| `prometheus/prometheus.yml` | Scrape config — container DNS names on the shared network. |
| `prometheus/alerts/vpp-alerts.yml` | 26 alert rules, all against metric names that exist (see file header). |
| `alertmanager/config.yml` | Routing tree; secrets via mounted files (`*_file` options). |
| `alertmanager/config.yml.tmpl` | Alternative env-rendered variant (`envsubst`). |
| `alertmanager/secrets/` | Placeholder secret files — **replace, never commit real values**. |
| `grafana/datasources/` | Prometheus (uid `prometheus`) + Jaeger (uid `jaeger`). |
| `grafana/dashboards/` | platform-overview, trace-pipeline, service-latency-errors (+ legacy kafka/redis/temporal dashboards). |
| `infrastructure/k8s/ha/otel-collector-ha.yaml` | Collector ConfigMap+Deployment+Service in namespace `monitoring`. |
| `infrastructure/k8s/ha/jaeger-ha.yaml` | Jaeger all-in-one Deployment+Service (dev/staging; see header for prod guidance). |

## Networks (read before booting)

All stacks share one Docker network so cross-stack DNS works:

- `docker-compose.middleware.yml` **creates** `vpp-platform-net`
  (subnet `172.31.255.0/24`; the subnet only exists so the
  `tigerbeetle-statsd` sidecar can pin `172.31.255.10` — TigerBeetle's
  `--statsd` flag requires a literal IP, no DNS).
- `docker-compose.monitoring.yml` and `services/docker-compose.yml` **join**
  it as `external`.

Therefore, one of these must happen **first**, once per Docker host:

```bash
docker network create vpp-platform-net --subnet=172.31.255.0/24
# or simply boot the middleware stack first, which creates it:
docker compose -f docker-compose.middleware.yml up -d
```

## Boot

```bash
# 0. shared network (idempotent)
docker network create vpp-platform-net --subnet=172.31.255.0/24 2>/dev/null || true

# 1. middleware + observability backends (jaeger, otel-collector, temporal,
#    keycloak, permify, apisix, tigerbeetle+statsd, kafka, redis, ...)
docker compose -f docker-compose.middleware.yml up -d

# 2. monitoring stack (prometheus, grafana, alertmanager, exporters)
docker compose -f docker-compose.monitoring.yml up -d

# 3. IoT pipeline (optional)
docker compose -f services/docker-compose.yml up -d

# --- production (layered, one project) ---
cp .env.example .env   # fill in every ${VAR:?} value
docker network create vpp-platform-net --subnet=172.31.255.0/24 2>/dev/null || true
docker compose \
  -f docker-compose.middleware.yml \
  -f docker-compose.monitoring.yml \
  -f docker-compose.prod.yml \
  --env-file .env up -d
```

UIs: Grafana http://localhost:3001 (admin/admin dev) · Prometheus
http://localhost:9090 · Alertmanager http://localhost:9093 · Jaeger
http://localhost:16686.

## Environment contract (services)

Every instrumented service receives:

| Var | Value | Notes |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4317` | gRPC. Browser RUM uses HTTP `:4318` (CORS-enabled for `$OTEL_RUM_ALLOWED_ORIGIN`). |
| `OTEL_SERVICE_NAME` | per service | `vpp-server`, `payment-worker`, `dr-worker-ts`, `trading-worker`, `prepaid-worker`, `optimizer`, `gridmodel`, `grid-protocols`, `mqtt-fluvio-bridge`, `fluvio-database-consumer`, `fluvio-analytics-consumer`, `modbus-poller` |
| `OTEL_SERVICE_VERSION` | deployment version | resource attr `service.version` |
| `OTEL_ENVIRONMENT` | `development` / `production` | resource attr `deployment.environment` |
| `OTEL_TENANT_ID` | default `default` | resource attr `tenant.id`; see multi-tenant section |
| `OTEL_SDK_DISABLED` | `false` | escape hatch: `true` disables SDK init |

Workers additionally get `METRICS_PORT` (payment 9091, dr 9092, trading 9093,
prepaid 9094) for their Prometheus `/metrics` endpoints.

The collector itself consumes `OTEL_TENANT_ID`, `OTEL_ENVIRONMENT`,
`OTEL_RUM_ALLOWED_ORIGIN` (set on its container; the config file references
them via `${env:...}`).

## Verifying a trace end-to-end

```bash
# 1. hit any instrumented HTTP endpoint
curl -s http://localhost:3000/health

# 2. open Jaeger, select service "vpp-server", Find Traces
xdg-open http://localhost:16686  # UI: service dropdown -> vpp-server

# 3. or query the Jaeger API directly
curl -s "http://localhost:16686/api/traces?service=vpp-server&limit=5" | head -c 400

# 4. confirm the pipeline counters moved
curl -s http://localhost:8888/metrics | grep -E "otelcol_receiver_accepted_spans|otelcol_exporter_sent_spans"

# 5. browser RUM path (what the client does): POST OTLP/HTTP JSON to :4318
curl -X POST http://localhost:4318/v1/traces \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:8080" \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"rum-smoke"}}]},"scopeSpans":[{"scope":{},"spans":[{"traceId":"5b8aa5a2d2c872e8321cf37308d69df2","spanId":"051581bf3cb55c13","name":"rum-smoke-test","kind":1,"startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000001000000000"}]}]}]}'
```

No traces? Check `OtelCollectorDown`/export alerts, or
`docker logs vpp-otel-collector` — the debug exporter echoes ~1/200 items.

## Alerts

Rules: `prometheus/alerts/vpp-alerts.yml` (26 rules). Highlights:

- **SLO**: `HttpHighErrorRate` (5xx ratio > 5%), `HttpHighLatencyP95` (> 1s)
  from `http_server_request_duration_seconds_*` (labels `service_name`,
  `tenant_id`, `http_response_status_code`, `http_route`).
- **Temporal**: workflow failure ratio (`workflow_failed`/`workflow_success`),
  backlog-with-no-pollers (`service_requests{operation=~"Add*Task"}` while
  `poll_success` == 0), server `service_errors`.
- **Kafka**: `kafka_consumergroup_lag` > 1000, vpp-server publish
  errors/latency (`kafka_messages_published_total`,
  `kafka_publish_duration_seconds_bucket`).
- **Redis/Postgres**: `redis_up`, memory vs `maxmemory`, evictions; `pg_up`,
  `pg_stat_activity_count`.
- **TigerBeetle**: `up{job="tigerbeetle"}`, `absent(tb_replica_status)`,
  `tb_replica_status != 0`.
- **Collector pipeline**: `otelcol_receiver_refused_spans`,
  `otelcol_exporter_send_failed_spans`, drop-ratio > 1%, `OtelCollectorDown`.
- **Watchdog**: `vector(1)` fires 24/7 → routed to the DeadMansSwitch webhook
  (repeat 1m). If pings stop, the external service alerts — this catches a
  silently dead Prometheus/Alertmanager.

Reload after edits: `curl -X POST http://localhost:9090/-/reload`.

## Alerting secrets

`alertmanager/config.yml` never contains credentials; it reads them via
Alertmanager's `*_file` options from `/etc/alertmanager/secrets/`, mounted
from `./alertmanager/secrets`:

| File | Contents | Used by |
|---|---|---|
| `slack_webhook_url` | Slack Incoming Webhook URL | all Slack receivers |
| `pagerduty_routing_key` | Events API v2 routing/integration key | `pagerduty` receiver |
| `watchdog_webhook_url` | Dead-man's-switch ping URL (healthchecks.io, Dead Man's Snitch, internal) | `watchdog` receiver |
| `smtp_auth_password` | SMTP password | only if you add email receivers |

**Do not commit real values.** The tracked files are placeholders so a fresh
clone boots. In production, mount a different directory over
`/etc/alertmanager/secrets` (Docker secret, Sealed Secret, Vault agent
volume). Alternative: render the env-based variant instead —

```bash
SLACK_WEBHOOK_URL=... PAGERDUTY_ROUTING_KEY=... WATCHDOG_WEBHOOK_URL=... \
ALERT_EMAIL_TO=... SMTP_SMARTHOST=... SMTP_FROM=... SMTP_AUTH_USERNAME=... SMTP_AUTH_PASSWORD=... \
envsubst < alertmanager/config.yml.tmpl > alertmanager/config.rendered.yml
```

and mount `config.rendered.yml` (keep it out of git).

## Multi-tenant story (honest)

The platform schema is **single-tenant per deployment** — there are no
`tenantId` columns in `drizzle/schema.ts`. Tenant attribution is therefore:

1. **Deployment-level label**: `OTEL_TENANT_ID` is set on every service and
   on the collector. The collector's `resource/tenant` processor upserts
   `tenant.id` onto every span/metric/log that passes through (services also
   set it themselves — belt and braces). With
   `resource_to_telemetry_conversion` enabled, it becomes the `tenant_id`
   Prometheus label, so all SLO rules and dashboards can slice by tenant.
2. **Per-request identity**: the TS coder sets `user.id`/`user.openId` span
   attributes from the tRPC context — that is per-user attribution inside a
   deployment, visible in Jaeger, not a separate tenant.

If true multi-tenant SaaS ever lands, the path is: schema `tenantId` →
span/metric attribute `tenant.id` set per-request in the tRPC context → the
same collector config keeps working unchanged (its upsert only applies the
deployment default).

## TigerBeetle (honest note)

TigerBeetle has **no Prometheus/HTTP metrics endpoint**. Its only metrics
output is StatsD (DogStatsD) via `tigerbeetle start --experimental
--statsd=<IP>:<port>` — and the flag accepts a literal IP only, no DNS
(docs.tigerbeetle.com/operating/monitoring). That is why:

- `docker-compose.middleware.yml` runs a `prom/statsd-exporter` sidecar
  (`tigerbeetle-statsd`, pinned `172.31.255.10`), and TigerBeetle pushes
  `tb.*` metrics to it over UDP. Prometheus scrapes the sidecar as job
  `tigerbeetle` → series like `tb_replica_status{cluster,replica}`.
- `up{job="tigerbeetle"}` covers the **pipeline**, not the replica (UDP is
  fire-and-forget) — hence the additional `absent(tb_replica_status)` alert,
  which fires when the replica itself stops emitting.
- The other real option (recommended by TigerBeetle themselves): client-side
  metrics around `createClient` calls in `server/services/ledger/tigerbeetle.ts`
  (latency/errors per operation), which the TS OTel wiring provides via the
  server SDK — visible as `service_name="vpp-server"` spans/metrics.

## In-cluster (Kubernetes)

`kubectl apply -f infrastructure/k8s/ha/otel-collector-ha.yaml
-f infrastructure/k8s/ha/jaeger-ha.yaml` creates namespace `monitoring` with
the collector (2 replicas, same pipeline as compose, ConfigMap-mounted) and
Jaeger all-in-one. The Service `otel-collector.monitoring.svc.cluster.local`
on `:4317` is exactly the OTLP target `permify-ha.yaml` already references.
In-cluster Prometheus scrapes collector self-telemetry via pod annotations;
the compose-only `prometheus/infra` receiver is intentionally dropped from
the k8s variant (no kafka-exporter etc. in these manifests). Jaeger
all-in-one is in-memory — see `jaeger-ha.yaml` header for the durable
production option.

## Validation

Run from repo root (binaries: `otelcol` 0.116.x, `promtool` 2.53.x, `amtool`
0.27.x, Docker Compose v2.32.x):

```bash
otelcol validate --config=observability/otel-collector-config.yaml
docker compose -f docker-compose.middleware.yml config -q
docker compose -f docker-compose.monitoring.yml config -q
docker compose -f docker-compose.external-services.yml config -q
docker compose -f services/docker-compose.yml config -q
docker compose --env-file .env -f docker-compose.middleware.yml \
  -f docker-compose.monitoring.yml -f docker-compose.prod.yml config -q
promtool check rules prometheus/alerts/*.yml
promtool check config prometheus/prometheus.yml
amtool check-config alertmanager/config.yml
```

Latest results (this change): `otelcol validate` exit 0 (compose and k8s
ConfigMap variants); all five `config -q` runs OK; `promtool check rules`
SUCCESS (26 rules); `promtool check config` SUCCESS; `amtool check-config`
SUCCESS (2 inhibit rules, 7 receivers).
