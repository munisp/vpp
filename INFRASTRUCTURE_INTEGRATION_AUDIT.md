# Infrastructure integration audit — 13 dependencies

Scope: how robust and how integrated each named dependency actually is in this codebase, as of
`devin/1787506000-nav-groups` (PR #40 merged). Classification is by evidence in the code, not by
documentation claims:

| Level | Meaning |
| --- | --- |
| `absent` | Not in the codebase at all. |
| `deployment_only` | Kubernetes/compose manifests exist; no application code path uses it. |
| `client_implemented` | A real client exists in the codebase but nothing in a request path calls it. |
| `wired` | Called on real request paths. |
| `proven` | `wired`, plus exercised at runtime against the real dependency in this repo's tests or session evidence. |

## Summary

| # | Dependency | Level | Money/grid critical? |
| --- | --- | --- | --- |
| 1 | PostgreSQL | **proven** | yes — all money, control, settlement state |
| 2 | TigerBeetle | **deployment_only** (code removed, fails loudly) | yes |
| 3 | Redis | **wired** (cache + Keycloak token cache) | no, today |
| 4 | Mojaloop | **absent** | yes — this is the missing payout provider |
| 5 | Kafka | **wired** (publish-only, no consumer in-repo) | partly — settlement events |
| 6 | APISIX | **deployment_only** | yes — it is the auth/rate-limit edge in the manifests |
| 7 | Keycloak | **client_implemented**, unused | yes — identity |
| 8 | open-appsec | **deployment_only** | no |
| 9 | Permify | **deployment_only** (Go struct holding config, no calls) | yes — authorization |
| 10 | OpenSearch | **absent** | no |
| 11 | Fluvio | **wired** in the MQTT bridge (CLI transport), unproven | no |
| 12 | Dapr | **client_implemented** (state helpers), no activity calls it | no |
| 13 | Lakehouse (Iceberg/MinIO) | **client_implemented** (two Python ETL scripts, nothing schedules them) | no |

Nothing in this list is silently faking success today: the TigerBeetle activities, the Fluvio producer
and the Go Permify/Keycloak/Lakehouse services all either fail loudly or hold configuration only, and
`docker-compose.middleware.yml` / `infrastructure/k8s/ha/*` are honest about being deployment manifests.
The dishonesty is at the *documentation* level — `MIDDLEWARE_ARCHITECTURE.md` and
`INTEGRATION_ARCHITECTURE.md` describe a 13-service mesh that the running application does not use.

## Per dependency

### 1. PostgreSQL — proven
Every table in `drizzle/` plus the Go worker and Python workers. Migrated from MySQL in #6 and
validated against a live server repeatedly since (`0000_postgres_baseline.sql`, ~97 tables, ~161 enums).
Robustness gaps found and worth fixing:
- **Pool exhaustion is not surfaced as unavailability.** Fixed for the twin in #35, but the general
  pattern (a backend termination taking the process down) should be a single pool-level policy.
- **No statement timeout, no `idle_in_transaction_session_timeout`** — a stuck settlement transaction
  can hold row locks indefinitely.
- **No read/write split and no explicit isolation level** on the settlement chain append; it relies on
  a unique constraint plus retry (which #37 fixed to actually work).
- Raw SQL must double-quote inherited camelCase identifiers; that is a standing footgun with no lint.

### 2. TigerBeetle — deployment_only, money paths disabled
`infrastructure/k8s/ha/tigerbeetle-ha.yaml` deploys a 3-node cluster. In code, the service was
**deleted** during earlier mockware remediation because the user→ledger-account mapping, ledger codes
and treasury/fee accounts would have had to be invented; five activities now return
`errLedgerNotConfigured` (`orchestrator/activities/activities.go`). The comment claims the
`tigerbeetle-go` client is "already declared in go.mod" — **it is not** (checked `go.mod`/`go.sum`).
So the platform's double-entry ledger does not exist; money movement is tracked in
`settlement_events` (hash-chained, single-entry) instead.
Recommendation: implement it properly — chart of accounts as a migration (member liability, treasury,
gateway clearing, fee revenue), TigerBeetle as the authority for balances, `settlement_events` as the
audit chain, and a reconciliation job comparing the two. This is the single highest-value item here.

### 3. Redis — wired, but not for anything that needs it
Real `ioredis` client, used as a cache (`user:profile`, `asset:details`, market price, DR events) and
for the Keycloak token cache. Gaps:
- ~~**Rate limiting is in-memory**~~ **Fixed.** Counters now live in Redis
  (`server/services/rate-limit-store.ts`), so a limit means the same thing behind any number of
  replicas. Production refuses to boot without `REDIS_HOST` unless `RATE_LIMIT_STORE=memory` accepts
  per-replica limits deliberately; a Redis outage refuses money requests (`503`
  `RATE_LIMIT_COUNTER_UNAVAILABLE`) and downgrades the general API to per-replica counting with a log
  line, rather than admitting either unmetered.
- **No distributed lock / idempotency key store.** Concurrency safety currently rests entirely on
  Postgres unique constraints — which is *correct* and stronger, so this is a note, not a defect.
- Cache errors are swallowed and return `null`, i.e. a Redis outage looks like a cache miss. Fine for
  cache; it must never become the store for anything authoritative without changing that.
- Redis is not one of the `DEPENDENCIES` in the degraded-operation layer, so its outages are invisible.

### 4. Mojaloop — absent
No reference anywhere. This matters more than its absence suggests: the platform still has **no seller
payout provider** (`payout_status = unavailable_no_provider`), which is the one gap that keeps P2P
settlement from ever reaching `complete`. Mojaloop (or a real mobile-money disbursement API) is the
missing half of the fund flow.

### 5. Kafka — wired, publish-only
`kafkajs` producer with Prometheus metrics, publishing ~30 topics from real service paths
(`settlement-ledger.createEvent` publishes synchronously). Gaps:
- **No consumer exists in this repo.** Every "publish to Kafka for lakehouse analytics" call site
  writes to a topic nobody reads (the Iceberg ETL script is the intended consumer but is not deployed).
- `settlement_events` publishing is synchronous with KafkaJS retries, so with no broker every ledger
  event costs ~30 s. That is a latency landmine on money paths.
- No outbox: a publish failure after the DB commit loses the event silently.
- No schema registry; every payload is ad-hoc JSON.

### 6. APISIX — deployment_only
`infrastructure/apisix-config.yaml` + `apisix-ha.yaml` define routes, JWT auth and rate limits at the
edge. The application knows nothing about it: it does not trust or validate any gateway header, does
not read `X-Forwarded-For` for its own limiter, and duplicates auth internally. Risk: if APISIX is the
only thing enforcing a limit or a JWT audience, direct pod access bypasses it entirely.

### 7. Keycloak — client_implemented, not used
`keycloak-client.ts` (admin API, users, roles) and `keycloak-auth.ts` (`keycloakProtect` middleware)
are real, but **no route mounts them**; authentication is the platform's own `app_session_id` JWT.
Two defects that would ship the moment it is wired:
- ~~`verifyToken` caches for a fixed 300 s ignoring `exp`~~ **Fixed.** The cache TTL is the shorter of
  five minutes and the token's own remaining life less a safety margin, an expired cache entry is
  dropped rather than honoured, and a token that expired between issue and verification is rejected
  instead of cached.
- ~~The cache key is `keycloak:token:<raw access token>`~~ **Fixed.** The key is a SHA-256 of the
  token, so Redis keyspace output no longer carries usable bearer tokens.

### 8. open-appsec — deployment_only
One manifest (`openappsec-ha.yaml`). WAF at the ingress; no application coupling expected, so this is
appropriate — but nothing verifies it is in front of the app.

### 9. Permify — deployment_only
`permify-ha.yaml` deploys it; `PermifyService` in Go **holds config and makes no calls** (documented as
such). Authorization is instead: tRPC `adminProcedure` + per-row ownership checks (hardened in #15,
#36, #40). That is real but scattered — a member/business/community/operator relation model is exactly
what Permify is for, and the current per-router checks are where cross-tenant holes keep appearing.

### 10. OpenSearch — absent
No client, no manifest, no code. Audit-log and settlement search is SQL `LIKE` over Postgres today.

### 11. Fluvio — wired, unproven
`services/mqtt-fluvio-bridge` publishes via the `fluvio` **CLI** (no Go SDK exists) or Kafka, selected
by `stream.transport`, refusing to start on an unknown transport, a missing topic, or
`required_acks: none`. Never run against a live Fluvio cluster; the CLI must be in the runtime image.

### 12. Dapr — client_implemented
`dapr.NewClient()` is created at orchestrator startup (and **fails startup if no sidecar answers**),
with `SaveState`/`GetState` helpers that **no activity calls**. So Dapr is a hard startup dependency
that provides nothing. Either use it for state/pubsub/service-invocation or drop the client.

### 13. Lakehouse — client_implemented
Two real Python scripts: `services/lakehouse/etl_pipeline.py` (Postgres → S3/MinIO Parquet) and
`server/integration/lakehouse-etl.py` (Kafka → Iceberg via `pyiceberg`, Hive metastore). Neither is
scheduled, containerised in this repo, covered by tests, or present in CI, and nothing reads back from
Iceberg — no query path, no provenance, no table maintenance (compaction/expiry). It is the intended
substrate for the ML/Ollama work, so it needs to become real first.

## Recommended order of work

1. **TigerBeetle double-entry ledger** (money correctness) + reconciliation against `settlement_events`.
2. **Mojaloop / real payout provider** — closes the fund-flow gap that blocks `settlement complete`.
3. **Kafka outbox + a real consumer**, and make settlement publishing asynchronous.
4. **Lakehouse for real** — scheduled ETL, Iceberg tables with provenance, a read path.
5. **Ollama diagnostics on the lakehouse** (advisory only; cannot move money or dispatch).
6. **Keycloak wired** (with the `exp`/plaintext-token fixes) and **Permify** for the relation model.
7. **Redis-backed rate limiting**, Postgres timeouts, APISIX header trust, and dependency observations
   for Redis/Kafka/Postgres so their outages are visible to the degraded-operation layer.
8. **OpenSearch** for audit/settlement search; **Dapr** either used or removed; **Fluvio** proven
   against a cluster.
9. **ML/GNN stack** (PyTorch + Ray) on top of 4.

Each of these is its own PR, and each one that is left undone must keep reading as `absent` or
`unavailable` in the UI rather than as a healthy integration.
