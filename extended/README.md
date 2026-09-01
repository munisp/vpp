# VPP Extended Components Stack

Six platform components that do not exist anywhere else in this repo, provisioned
as **one new, self-contained compose stack**: `docker-compose.extended.yml` plus
the configs in this directory. **No existing file was modified.**

| # | Component | What it is | Runs as |
|---|-----------|------------|---------|
| 1 | **Mojaloop** | Open-source instant-payments switch (FSPIOP). Credible compose core, not the full helm hub | 5 app services + 4 handler services + Kafka/Mongo/2×MySQL |
| 2 | **OpenSearch** | Search/analytics engine + Dashboards, with the official Prometheus exporter plugin | `opensearch` (built from `extended/opensearch/Dockerfile`) + `opensearch-dashboards` |
| 3 | **Apache Sedona + lakehouse** | Sedona is a **Spark library, not a server** — so this is a real Spark 3.5.9 standalone cluster (master+worker) that loads Sedona 1.9.1 jars, wired to the existing MinIO lakehouse | `spark-master`, `spark-worker`, one-shot `sedona-smoke` job |
| 4 | **GeoLibre** | A **client-side, browser-first GIS app** (see honest assessment below) — not a backend service | Official image `ghcr.io/opengeos/geolibre` (nginx + bundled Python sidecar) |
| 5 | **open-appsec** | ML-based WAF: agent + NGINX attachment, locally managed (standalone) | `appsec-agent`, `appsec-nginx`, + smartsync/shared-storage/tuning/postgres helpers |
| 6 | **Novu** | Self-hosted open-source notification infrastructure (product-notification layer) | `novu-api`, `novu-worker`, `novu-ws`, `novu-dashboard` + own MongoDB/Redis |

---

## 0. Prerequisites & boot

1. The monitoring stack must be up first (it creates the `monitoring` network
   that Prometheus scrapes on, and the middleware/external-services stack
   creates `vpp-network` with the MinIO lakehouse used by Sedona and Novu):

   ```bash
   docker compose -f docker-compose.monitoring.yml up -d
   docker compose -f docker-compose.middleware.yml up -d   # provides MinIO (vpp-network)
   ```

2. Prepare secrets (fail-loud: the compose file refuses to render without them):

   ```bash
   cp extended/.env.example .env
   cat extended/novu/.env.example >> .env
   $EDITOR .env   # set OPENSEARCH_INITIAL_ADMIN_PASSWORD + all NOVU_* secrets
   ```

3. Boot:

   ```bash
   docker compose -f docker-compose.monitoring.yml -f docker-compose.extended.yml up -d
   ```

   Network names default to the compose-project-derived `vpp_monitoring` and
   `vpp_vpp-network` (project = directory name `vpp`). If you use a custom
   project name (`-p foo`), set `MONITORING_NETWORK_NAME` / `VPP_NETWORK_NAME`
   accordingly in `.env`.

### Resource footprint warning

This stack is **heavy**. Guidance for a dev machine:

| Group | Approx. RAM |
|-------|-------------|
| Mojaloop core (5 apps + 4 handlers + Kafka + Mongo + 2 MySQL) | 4–6 GB |
| OpenSearch (1g heap) + Dashboards | 2–2.5 GB |
| Spark master + worker (2G worker) + smoke job | 3–4 GB |
| Novu (4 services + Mongo + Redis) | 2–3 GB |
| open-appsec (6 containers) | 1–1.5 GB |
| GeoLibre | ~0.3 GB |
| **Total** | **≈ 13–17 GB on top of the existing platform** |

Do not boot this on an 8 GB machine together with the rest of the platform.
Selective bring-up works with compose service filtering, e.g. only Novu:
`docker compose -f docker-compose.extended.yml up -d novu-mongodb novu-redis novu-api novu-worker novu-ws novu-dashboard`.

### Merging the Prometheus scrape fragment

`extended/prometheus-extended.yml` is a **scrape-config fragment**. Append its
`scrape_configs:` entries to `prometheus/prometheus.yml` (owned by the INFRA
coder — deliberately not edited here) and reload Prometheus
(`curl -X POST http://localhost:9090/-/reload`). Set the OpenSearch
`basic_auth` password in the fragment to your `OPENSEARCH_INITIAL_ADMIN_PASSWORD`.

---

## 1. Mojaloop (payments switch core)

**What was provisioned:** the credible core of a Mojaloop hub in pure compose:

- `central-ledger` (v19.14.0) — ledger API + migrations; `central-ledger-handlers`
  (prepare/position/get/fulfil/timeout/admin handlers, one process)
- `ml-api-adapter` (v16.10.1) — FSPIOP entry point + `ml-api-adapter-handler` (notifications)
- `account-lookup-service` (v17.16.2, API 4002 + admin 4001) + `-handlers` (timeout)
- `quoting-service` (v17.14.4, API 3002) + `-handlers` (quotes/bulk/fx)
- `transaction-requests-service` (v14.4.9, API 4003)
- Backends: single-node KRaft Kafka (`bitnamilegacy/kafka:3.5`) with the
  upstream topic-provisioning script (extended by the quoting topics),
  MongoDB 8.0.17 objstore, MySQL 8.0 (`mysql` = central_ledger schema,
  `mysql-als` = account_lookup schema).

Configs are **vendored from the upstream repos' own `docker/` directories**
(`mojaloop/central-ledger`, `mojaloop/ml-api-adapter`, `mojaloop/account-lookup-service`,
`mojaloop/quoting-service`, `mojaloop/transaction-requests-service`) with minimal,
reviewable patches: redis-cluster proxy/payload caches and dist-locks disabled
(no Redis cluster in this stack), JWS signing disabled (no key material),
`SWITCH_ENDPOINT` pointed at `central-ledger:3001`, dev credentials
(`central_ledger`/`password`, `account_lookup`/`password`).

**Host ports:** ml-api-adapter `13000`, central-ledger `13001`, quoting `13002`/`13003`,
ALS `14001`/`14002`, TRS `14003`, Kafka `19092`, MySQL `3306`/`3307`, Mongo `27017`.
Health: `curl http://localhost:13001/health` etc.

**Observability:** every Mojaloop service exposes Prometheus `/metrics` on its
API/monitoring port (prefixes `moja_cl_`, `moja_ml_`, `moja_als_`, `moja_qs_`,
`moja_trs_`) — all wired in `extended/prometheus-extended.yml`.

**Honest scope limits (read this):**
- This is **not** the full Mojaloop hub. Missing vs. the helm chart:
  central-settlement, central-event-processor, bulk-api-adapter, event-sidecars,
  ALS oracles (msisdn/pathfinder), auth-service, TTK test harness, simulator DFSPs,
  Connection-Manager/mTLS and JWS signing. Discovery/agreement/transfer message
  paths exist, but there are **no simulated DFSP participants onboarded**, so an
  end-to-end transfer requires onboarding participants first (Mojaloop Postman
  collections / `populateTestData.sh` from the central-ledger repo).
- Single-process handler sets (helm runs each handler as its own deployment).
- Dev-grade security: plaintext Kafka/MySQL, empty MySQL root password
  (`MYSQL_ALLOW_EMPTY_PASSWORD=true`, matching upstream's own dev compose),
  default DB passwords in vendored configs. **Do not expose these ports publicly.**
- The official production path is Kubernetes + helm (`mojaloop/helm` v17.2.0);
  this compose core tracks the same application versions (mid-2026 releases).

## 2. OpenSearch

- `opensearch`: built from `extended/opensearch/Dockerfile` =
  `opensearchproject/opensearch:3.8.0` + official
  `prometheus-exporter-3.8.0.0` plugin (plugin is **version-locked** — bump both
  together). Single node, security plugin **enabled** (demo certs),
  `OPENSEARCH_INITIAL_ADMIN_PASSWORD` is **required and must be strong** —
  OpenSearch exits on boot otherwise (fail-loud by design).
- `opensearch-dashboards:3.8.0` on `http://localhost:5601` (log in as `admin`).
- Metrics: `https://opensearch:9200/_prometheus/metrics` (basic auth) — in the
  scrape fragment; `prometheus.indices=false` set to keep label cardinality sane.
- **Security note:** this is the upstream *demo* configuration (well-known demo
  certificates). For anything beyond local dev, replace certs, create a
  dedicated read-only metrics user, and change the admin password (already
  forced via env). Intended use: future platform log/event indexes + dashboards.

## 3. Apache Sedona + lakehouse

Sedona is a **library**, so the honest artifact is a real Spark cluster with the
Sedona runtime loaded:

- `spark-master` / `spark-worker`: official `apache/spark:3.5.9-scala2.12-java11-python3-ubuntu`.
  Version matrix (verified against sedona.apache.org): **Sedona 1.9.1 ↔ Spark 3.5 ↔
  Scala 2.12 ↔ Java 11**. Master UI `http://localhost:18080`, worker UI `:18081`,
  master RPC `7077`.
- `sedona-smoke` (profile `smoke`, not auto-started): `spark-submit`s
  `extended/sedona/smoke/sedona_smoke.py`, which registers Sedona via the JVM
  bridge (no pip package needed), runs `ST_Point`/`ST_Transform`/`ST_Distance`,
  and round-trips **GeoParquet to the existing MinIO lakehouse** via s3a using the
  same env names as the orchestrator (`LAKEHOUSE_ENDPOINT`, `LAKEHOUSE_BUCKET`,
  default `http://minio:9000` / `vpp-data`). Run it:

  ```bash
  docker compose -f docker-compose.extended.yml --profile smoke up sedona-smoke
  docker compose -f docker-compose.extended.yml logs sedona-smoke   # expect SEDONA_SMOKE_OK
  ```

  First run downloads Sedona/hadoop-aws jars from Maven Central (a few minutes).
- Metrics: Spark `PrometheusServlet` (`extended/sedona/metrics.properties`) on
  `/metrics/prometheus/` of the master/worker UIs — in the scrape fragment.
- Lakehouse bucket: the smoke job expects the `vpp-data` bucket (or your
  `LAKEHOUSE_BUCKET`) to exist in MinIO; create it in the MinIO console
  (`http://localhost:9001`) if the platform hasn't already.

## 4. GeoLibre — honest assessment

**What it actually is** (verified at github.com/opengeos/GeoLibre, v2.5.0,
Aug 2026): a free, open-source, **client-side GIS application** built with
Tauri v2 + React + MapLibre GL + DuckDB-WASM Spatial + deck.gl. It runs in the
browser, on the desktop, on mobile, and in Jupyter. Its 1000+ geoprocessing
tools execute **in the browser on WebAssembly** — "no server, no install".
It is **not a backend service** and has no server-side metrics, no database,
no API surface to instrument.

**What was provisioned (the honest runnable artifact):** the **official published
web image** `ghcr.io/opengeos/geolibre:latest` (built and published by the
upstream repo's own CI: Vite build served by nginx, plus a bundled Python
uvicorn "conversion sidecar" reverse-proxied at `/sidecar`). It runs at
`http://localhost:8180` with:

- `GEOLIBRE_SHARE_URL=off` — hosted share/collab servers disabled (private,
  self-contained deployment; per upstream self-hosting docs),
- `geolibre-data` volume at `/data` (`GEOLIBRE_CONVERSION_ROOTS`) — mount your
  GeoTIFF/GeoParquet files there to use the raster/conversion tools.

**Integration points** (rather than a fake "service skeleton", which was
explicitly out of scope): use it as the platform's geospatial workbench next to
the Sedona lakehouse; embed it via `GEOLIBRE_EMBED_ORIGINS`; its SQL workspace
(DuckDB Spatial / PGlite / Sedona) complements the Spark Sedona cluster.
**No Prometheus wiring exists for it** — nginx serves static files and the
project publishes no metrics endpoint; this is stated, not silently dropped.

## 5. open-appsec (WAF)

- Mirrors the **official** `deployment/docker-compose/nginx` stack from
  github.com/openappsec/openappsec: `appsec-agent` (`ghcr.io/openappsec/agent`)
  + `appsec-nginx` (`ghcr.io/openappsec/nginx-attachment`) with `ipc: host` and
  the shared `shm-volume`, plus the **standalone** helpers so it works with no
  SaaS account: `appsec-smartsync`, `appsec-shared-storage`,
  `appsec-tuning-svc`, `appsec-db` (postgres:18). All images pinned together by
  `APPSEC_VERSION` (default `latest`).
- Locally managed via `extended/openappsec/localconfig/local_policy.yaml`
  (upstream default policy; `mode: inactive` = detect/learn, switch to
  `prevent-learn` to block). Optionally set `APPSEC_AGENT_TOKEN` to attach to
  the central WebUI (my.openappsec.io) instead.
- `extended/openappsec/nginx/default.conf` is a **placeholder vhost** (204 +
  `/healthz`) — reverse-proxy mode in front of nothing yet, deliberately.
  To protect the platform gateway later, add
  `location / { proxy_pass http://<apisix-or-upstream>:<port>; }` and point
  public traffic at ports `8088`/`8443`. open-appsec also ships an official
  APISIX integration (`deployment/apisix`) if preferred.
- **Metrics story (honest):** open-appsec exposes **no Prometheus endpoint**.
  Security events go to `/var/log/nano_agent` (volume `appsec-logs`, JSON on
  stdout via the log trigger) or the SaaS WebUI. Wiring "what exists" = the
  log destination; a future otel-collector/Promtail log pipeline can pick these
  up. Nothing else was invented.

## 6. Novu (notifications)

- Official images, all pinned to **3.19.0** (they share schema/job formats —
  keep tags equal): `ghcr.io/novuhq/novu/{api,worker,ws,dashboard}`.
- **Own datastores** (required): `novu-mongodb` (mongo:8.0.17) and `novu-redis`
  (redis:7-alpine). Novu uses Redis for BullMQ queues + cache with its own DB
  index; the platform Redis requires AUTH and is shared, so Novu correctly gets
  its own instance per the official community compose.
- Attachment storage reuses the **existing MinIO** on `vpp-network`
  (`S3_LOCAL_STACK=http://minio:9000` acts as the custom S3 endpoint;
  `novu-local` bucket — **create it once** in the MinIO console or with `mc`).
- Env/secrets: see `extended/novu/.env.example`. `NOVU_JWT_SECRET`,
  `NOVU_STORE_ENCRYPTION_KEY` (exactly 32 chars), `NOVU_SECRET_KEY`,
  `NOVU_MONGO_PASSWORD` are fail-loud. First boot allows open registration —
  **create the admin account immediately**, then disable registration
  (`DISABLE_USER_REGISTRATION=true` env on `novu-api`, documented in the example).
- Endpoints: dashboard `http://localhost:4200`, API `http://localhost:3100`,
  WS `http://localhost:3102`.
- **Platform adapter contract (for the TS coder):**
  `NOVU_BACKEND_URL=http://localhost:3100` (novu-api base URL) and
  `NOVU_API_KEY` (from Novu dashboard → Settings → API Keys).
- **Metrics (honest):** Novu v3 ships **no Prometheus `/metrics`** on
  api/worker/ws (its observability is New Relic/Sentry/OpenTelemetry-tracing
  oriented; the OTel pieces are custom-code, not a container env toggle). Wired
  instead: `novu-redis-exporter` (`oliver006/redis_exporter:v1.67.0`) and
  `novu-mongodb-exporter` (`percona/mongodb_exporter:0.44.0`) — both in the
  scrape fragment.

---

## OTel note

The shared `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317` contract is
honored where components actually support OTLP: **none of these six do natively**
(Mojaloop/Novu are Prometheus-exporter or vendor-telemetry apps; OpenSearch/Spark
expose Prometheus endpoints; GeoLibre is client-side; open-appsec is log-based).
All metrics therefore flow via **Prometheus scrape** (fragment provided) rather
than fake OTLP env vars on services that would ignore them. Logs (open-appsec
JSON, mojaloop stdout) are the natural future otel-collector input.

## Honest limitations (summary)

1. Mojaloop is a dev-grade **core**, not the full hub — no settlement, no DFSP
   simulators, no mTLS/JWS, no oracles; participants must be onboarded before
   end-to-end transfers work.
2. OpenSearch runs the upstream **demo security** setup (strong admin password
   enforced; demo certs retained).
3. GeoLibre is a browser app; nothing server-side to instrument — provisioned as
   the official web image, integration points documented.
4. open-appsec has no Prometheus metrics; its nginx fronts a placeholder vhost
   until a real upstream (APISIX) is assigned.
5. Novu has no native `/metrics`; only infra-level exporter metrics are wired.
   First-boot registration is open until `DISABLE_USER_REGISTRATION=true`.
6. The Sedona smoke job downloads jars from Maven Central on first run
   (internet required once; cache via a named ivy volume if desired).
7. All Mojaloop images are pinned to mid-2026 releases; bumping one service may
   require bumping siblings (they share Kafka topic contracts).

## Files in this directory

```
extended/
  README.md                     (this file)
  .env.example                  (shared env; Novu has its own below)
  prometheus-extended.yml       (scrape-config fragment to merge)
  opensearch/Dockerfile         (3.8.0 + prometheus-exporter 3.8.0.0)
  sedona/metrics.properties     (Spark PrometheusServlet)
  sedona/smoke/sedona_smoke.py  (spatial + GeoParquet-to-MinIO smoke job)
  mojaloop/                     (vendored upstream docker configs + topic
                                 provisioning + wait-for helper)
  openappsec/nginx/default.conf (placeholder vhost)
  openappsec/localconfig/local_policy.yaml
  novu/.env.example
  geolibre/                     (no config needed; env-only service)
```
