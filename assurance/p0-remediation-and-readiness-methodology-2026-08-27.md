# P0 Release-Gate Closure Blueprint and Scoring Methodology — 2026-08-27

**Scope:** This document turns the remaining P0 release blockers into implementable work packages. It uses the current migrated schema and audited source paths. It does not claim that external payment providers, TigerBeetle, Kafka, Temporal, Keycloak, or field devices were exercised.

> **Release condition:** All P0 work packages must produce immutable test artifacts and a reconciled result in an isolated, non-production topology. Source changes and a unit test alone do not close a money, grid-control, or recovery gate.

## P0-1 — Durable payment-initiation idempotency

### Current state

`paymentProcessing.initiatePayment` serializes simultaneous requests for a billing record with a PostgreSQL advisory lock and creates a pending payment before provider I/O. This prevents the known local race and retains ambiguous provider outcomes. It cannot identify a client retry after the original request releases the advisory lock, because the request lacks a durable idempotency key and the `payments` table has no corresponding uniqueness rule.

### Required schema migration

Create `drizzle/migrations/0024_payment_idempotency.sql` and register the same fields in `drizzle/schema.ts`.

```sql
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(128);

CREATE UNIQUE INDEX IF NOT EXISTS "payments_user_type_idempotency_key_uq"
  ON "payments" ("userId", "paymentType", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "requestFingerprint" varchar(64);
```

`requestFingerprint` is the SHA-256 digest of the canonical immutable initiation input: `userId`, `billingId`, `paymentType`, `gateway`, `amount`, `currency`, and normalized phone number. The database index identifies the repeated client command; the fingerprint prevents the same key from being reused for different money instructions.

### Required API and service changes

1. Require `idempotencyKey: z.string().uuid()` (or a documented, entropy-checked 32–128-character opaque key) in the `initiatePayment` tRPC input.
2. Calculate the canonical fingerprint before any database write.
3. In one transaction, execute `INSERT ... ON CONFLICT DO NOTHING RETURNING id`. On conflict, select the existing row with the same key and lock it with `FOR UPDATE`.
4. If the existing fingerprint differs, return `CONFLICT` and never contact a provider. If it matches, return the existing pending/completed/reconciliation response exactly; never initiate another provider request.
5. Include only the database-created payment ID and provider account reference in the outbound request. The provider reference must be unique and derived from the immutable payment ID, not client-provided data.
6. Retain unknown provider outcomes as pending and require reconciliation exactly as the current code does. A retry with the same key returns that pending/reconciliation response.
7. Have the mobile/web client create the key once per explicit “Pay” action and persist it until the server returns a terminal or reconciliation-required response. A new user action gets a new key.

### Required tests and evidence

| Test | Acceptance assertion |
|---|---|
| Same key, same payload, concurrent requests | Exactly one `payments` row; gateway mock receives exactly one initiation call; both callers receive the same payment ID. |
| Same key, altered amount/gateway/phone | API returns `CONFLICT`; no second provider call; original record remains unchanged. |
| Unknown timeout then retry with same key | Pending payment remains one row; retry returns reconciliation-required response; no second provider call. |
| Process interruption after insert/before provider result | A reconciliation worker finds the pending row by account reference and reaches an evidence-backed terminal or still-pending state. |
| Provider callback replay/conflict | Callback is accepted only once; conflicting amount/currency/reference is rejected and audit logged. |

The end-to-end run must use a provider sandbox test account, a disposable PostgreSQL database, a real TigerBeetle test instance, and captured provider callback evidence. Reconcile the provider transaction reference, `payments` row, billing status, TigerBeetle transfer, outbox event, and user-visible result.

## P0-2 — Durable manual wallet-top-up idempotency

### Current state

Automatic top-ups have a per-user advisory lock and an already-initiated-attempt check. Manual top-ups intentionally represent explicit purchases and currently have no durable retry identity, so a mobile retry after an uncertain response can initiate a second charge.

### Required schema migration

Create `drizzle/migrations/0025_wallet_topup_idempotency.sql` and add matching Drizzle fields in `drizzle/grid-intel-schema.ts`.

```sql
ALTER TABLE "wallet_top_up_attempts"
  ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(128),
  ADD COLUMN IF NOT EXISTS "request_fingerprint" varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_topups_user_key_uq"
  ON "wallet_top_up_attempts" (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

The manual top-up fingerprint covers `user_id`, `amount_cents`, `method`, normalized phone number, and `trigger_type`. Automatic rules may use an explicitly generated deterministic decision key such as `auto:<user>:<wallet-settings-version>:<balance-snapshot-id>`; do not reuse manual keys for automatic purchase decisions.

### Required route and service changes

1. Add `idempotencyKey` to `energyWalletRouter.requestTopUp` input and forward it to `energyWallet.initiateTopUp`.
2. Insert the attempt in `pending` or `initiating` state in a transaction before gateway I/O. On a duplicate key, lock/load the existing attempt and compare fingerprints.
3. Only the transaction that inserted the row can call the provider. A duplicate receives the existing attempt state and provider reference.
4. Store `gateway_checkout_id`, provider reference, and reconciliation metadata on the original row. Move terminal state only from verified provider callback/status evidence.
5. Update `WalletScreen` to generate an opaque request key before the first dispatch and reuse it only when retrying the same visible request. Clear it only when a terminal result is rendered.

### Required tests and evidence

Run the same-key/different-payload/timeout/retry tests from P0-1, plus a manual versus automatic key-separation test. Prove that two manual HTTP requests with the same key cause one provider request, while two intentional user top-ups with distinct keys create two valid attempts.

## P0-3 — Payment, ledger, callback, outbox, and workflow integration exercise

Use the repository’s middleware topology (PostgreSQL, Redis, Keycloak, Kafka, Temporal, TigerBeetle, and MinIO) in an isolated namespace with non-production credentials. The current `scripts/test-platform-e2e.sh` seeds **all 141 migrated public application tables** and runs local database invariant checks; it is a schema/data harness, not provider or ledger proof.

### Test sequence

1. Start the isolated dependencies and record immutable image digests and configuration hashes.
2. Apply migrations to a new `*_e2e` database and run `pnpm run test:e2e:seeded`.
3. Configure a provider sandbox callback URL and secret; record only redacted headers and transaction references.
4. Initiate one payment with a fresh idempotency key. Verify one payment row, one provider prompt, one outbox event, and one workflow ID.
5. Replay the original API request, replay the callback, send a callback with mismatched amount/currency, and inject a provider timeout after request acceptance. Confirm each expected refusal/pending/reconciliation outcome.
6. Run the reconciliation worker. Compare provider sandbox status, payment status, billing/token/trade action state, TigerBeetle transfer, ledger posting, Kafka outbox/inbox rows, and user-facing API response. Every item must agree or be durably marked for recovery.
7. Kill and restart the application/worker at each handoff boundary. Repeat with the same idempotency key and prove no duplicate provider, ledger, token, trade, or event effect.

## P0-4 — Grid dispatch and safety proof

### Current code guarantees

The code refuses unbounded/invalid windows, requires an explicit safe-limit watt value, stores `unconfirmed` instead of claiming a device accepted a command after a timeout, and sweeps expired assignments using a claimed fallback record. MQTT publication is deliberately recorded as broker-queued/unconfirmed because the device has no acknowledgement.

### Required simulator/device work

1. Add a `docker-compose.grid-e2e.yml` profile that starts a disposable MQTT broker, protocol service, and approved OCPP simulator or certified test charge point. Each service must have non-production credentials and isolated topics/identifiers.
2. Add `server/grid-dispatch-e2e.test.ts` that controls a simulator through the public routing boundary. The test must use actual HTTP/MQTT/OCPP protocol traffic—not a mocked `setChargingProfile` function.
3. Execute six test cases: command accepted; explicit device rejection; protocol timeout; device offline/reconnect; expired `safe_limit` fallback; expired `resume_local` clear command; and emergency-stop authorization/receipt.
4. For each test, persist a trace ID and assert the `control_assignments` row, protocol service record, broker/OCPP simulator receipt, fallback event, and device telemetry agree. A broker receipt alone is not evidence of physical application.
5. Run at least one certified non-production device exercise. Verify its local firmware enforces `validTo` when the platform/sweeper disappears; retain timestamped command, device telemetry, and operator approval artifacts.

## P0-5 — Recovery and rollback proof

Run this in a disposable production-shaped topology only. The objective is recovered consistency, not merely successful container startup.

1. Record source commit SHA, image digests, signed configuration manifest, migration version, encrypted backup object checksums, named operator, and start time.
2. Seed/migrate with `pnpm run test:e2e:seeded`; create controlled payments, pending unknown outcomes, wallet attempts, P2P trades, outbox records, control assignments, and workflow runs.
3. Take a PostgreSQL custom-format backup using `pg_dump --format=custom --no-owner --no-privileges`; separately capture Redis persistence/restore artifacts, Keycloak realm export, MinIO object inventory/version manifest, Kafka topic/offset plan, and Temporal namespace/workflow state according to the deployed service’s supported procedure.
4. Destroy the disposable application data volumes; restore to fresh instances in dependency order: PostgreSQL → Keycloak → MinIO → Redis → Kafka/Temporal metadata → application/workers. Reapply migrations only in the documented forward-safe direction.
5. Re-run hash and count comparisons: all migrated tables; payments/billings/tokens/trades; ledger account/posting/transfer references; wallet attempts/snapshots; event outbox/inbox/dead letters; control assignments/fallback events; Keycloak users/roles; MinIO objects; and recovery-time health/readiness endpoints.
6. Replay no provider request. Reconciliation must process existing durable account references and mark unknown/failed actions accurately; it must not create a second charge or token.
7. Test an application-version rollback independently of data rollback. If migrations are non-reversible, use a restore-point procedure rather than a fictional down migration. The rollback acceptance criterion is service health plus the same money/control consistency report.
8. Record actual RTO/RPO and compare them to an approved business target. A rehearsal that misses either target is a failed release gate even if data restoration technically completes.

## P0-6 — Mobile Metro `image-size` high findings

The current asset-admission script blocks the known input extensions before Expo/Metro build and CI export. It is a compensating control, not a vulnerability closure. Close this gate only by either upgrading Expo/React Native/Metro to a dependency graph that no longer includes vulnerable `image-size@1.2.1`, or applying a reviewed version-pinned patch/fork that adds parser forward-progress bounds.

A local patch must be committed under `patches/`, applied deterministically by the package manager, and tested with timeout-bounded malformed ICNS/JXL/HEIF fixtures. The production audit must report no high finding for both advisories after a frozen install. Do not edit `node_modules` without a version-pinned patch application mechanism.

## Exact readiness methodology

Each domain score uses four 0–100 subscores:

```text
DomainScore = round(0.30 × BusinessRuleRobustness
                  + 0.30 × LogicAccuracy
                  + 0.20 × Completeness
                  + 0.20 × OperationalEvidence)

OverallScore = Σ(DomainWeight × DomainScore) / 100
```

The applied weights are: payments 18; wallet 10; trading 10; grid dispatch 12; events/workflows 8; identity/authorization 10; web PWA 10; mobile 8; storage/AI/maps/notifications 8; and security/deployment/recovery 6. They total 100. Higher harm domains receive higher weights; a visually complete UI cannot offset unproven funds or safety controls.

| Domain | Business rules | Logic accuracy | Completeness | Operational evidence | Calculation | Score basis |
|---|---:|---:|---:|---:|---|---:|
| Payments | 70 | 65 | 50 | 20 | `0.30×70 + 0.30×65 + 0.20×50 + 0.20×20 = 54.5` | **55**. Rules are improved by production endpoint refusal, durable pre-provider attempt, webhook signature gate, and unknown-outcome retention. Completeness is reduced by missing durable cross-request idempotency; evidence is low because no provider/TigerBeetle/PostgreSQL callback/reconciliation run occurred. |
| Grid dispatch | 65 | 55 | 40 | 20 | `0.30×65 + 0.30×55 + 0.20×40 + 0.20×20 = 48.0` | **48**. Bounds/fallback/refusal/claim semantics are well specified and unit tested. Completeness/evidence are low because physical or simulator command acceptance, expiry, fallback, reconnect, and emergency evidence are absent. |
| Security, deployment, and recovery | 60 | 55 | 30 | 20 | `0.30×60 + 0.30×55 + 0.20×30 + 0.20×20 = 44.5` | **45**. CSP, secret scanning, build controls, and configuration checks exist. Completeness and evidence are low because CSP report-only/browser rollout, production topology, backup/restore, rollback, alerting, and DR RTO/RPO have not been demonstrated. |

The earlier overall score is therefore exactly:

```text
(18×55 + 10×58 + 10×55 + 12×48 + 8×47 + 10×62 + 10×78 + 8×63 + 8×48 + 6×45) / 100
= 56.30
```

The numeric score never overrides hard gates. Any unresolved P0 money, grid safety, recovery, or high-severity mobile dependency finding leaves the release decision **blocked**, even if a later weighted average increases.
