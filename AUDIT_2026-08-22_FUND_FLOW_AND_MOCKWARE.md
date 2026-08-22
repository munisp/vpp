# VPP Platform Audit — Fund Flow, Security & Silent Mockware

Date: 2026-08-22
Scope: full repository (`client/`, `server/`, `drizzle/`, `services/`, `workers/`, deployment config)
Verification run: `tsc --noEmit` clean, `vitest run` 36/36 passing, `vite build` + server bundle succeed.

---

## 1. Scores

| Dimension | Before | After | Notes |
| --- | --- | --- | --- |
| Fund-flow correctness | 3/10 | 7/10 | Authorization, idempotency and gateway-evidence holes closed; P2P settlement still incomplete by design |
| Authorization / trust boundaries | 4/10 | 8/10 | Self-service invoice/trade settlement removed, unsigned webhook path removed, telemetry device-authenticated, QR payloads signed |
| Truthfulness (no silent mockware) | 4/10 | 8/10 | Fabricated reconciliation, fake refunds, invented STS tokens and invented grid stress removed or gated |
| Concurrency / idempotency | 3/10 | 7/10 | Conditional state transitions, unique ledger chain slots, referral reward claim-before-credit |
| Test coverage of money paths | 2/10 | 4/10 | 36 unit tests; no integration tests against a real DB or gateway sandbox |
| Operational readiness | 4/10 | 5/10 | Lockfile drift fixed; secret/runbook/observability gaps remain |

### Production-readiness: **6.0 / 10 — NOT production-ready for real money yet**

Rationale: every defect found that could move money incorrectly, double-issue value, or
present a fabricated result as a real one is fixed or now fails loudly. What remains
blocking production is not defect density but *unfinished integrations and unproven
operation*: STS token vending, P2P settlement completion, automated refund disbursement,
and the absence of end-to-end tests against a real database and gateway sandbox.
None of those can be honestly scored from code inspection alone.

---

## 2. High-severity findings fixed

### 2.1 Users could settle their own money records
- `billing.markPaid` / status update was a `protectedProcedure`: any authenticated user could mark
  their own invoice `paid`. Now `adminProcedure`, and marking paid requires linked **completed**
  payments covering `consumerShare`; an optional `transactionId` must match one of them.
- `trading.updateTradeStatus` let a trade owner declare their own trade `executed`. Now only admins
  may set `executed`/`failed`; owners may only cancel a `pending` trade, using expected-state
  transitions.

### 2.2 Client-controlled payment verification
- `payments.verify` accepted a client-supplied `transactionId` and verified *that* reference,
  so a caller could point verification at any transaction. It now verifies only the stored
  gateway reference of the payment being settled.
- Repeat verification of a completed payment issued a second energy token. Completion is now an
  idempotent, conditional (`status = 'pending'`) transition, and token issuance is keyed on
  `tokens.paymentId`.
- Gateway rejection at initiation left the payment `pending` forever; it is now marked `failed`.

### 2.3 Client-selected gateway environment
- `paymentProcessing.initiatePayment` accepted `environment: 'sandbox' | 'production'` from the
  client, defaulting to `sandbox` — a caller could complete "payments" against the sandbox.
  The parameter is removed; `resolveGatewayEnvironment()` reads `PAYMENT_GATEWAY_ENVIRONMENT`,
  rejects sandbox in production, and refuses to guess when unset in production.

### 2.4 Unsigned webhook path that settled payments
- `mpesa-webhook.callback` was a public tRPC mutation that processed callbacks and completed
  payments without signature verification — replaying a `CheckoutRequestID` marked a payment paid.
  Removed; callbacks are only accepted on the signed `POST /api/webhooks/mpesa` route.
- The signed webhook handler ran post-payment actions even when its conditional update affected
  zero rows (duplicate callback). It now checks `affectedRows`, and a callback whose amount
  disagrees with the local record is held for manual reconciliation instead of settled.

### 2.5 Reconciliation compared the ledger to itself
- `payment-reconciliation.ts` built "gateway data" from the local payment row and then compared
  it to that same row, so everything reconciled `matched`. It now queries the provider
  (`PaymentGatewayManager.queryPaymentStatus`) and reports `unmatched` when there is no
  transaction ID, no queryable provider (e.g. bank transfer), or the gateway cannot be reached —
  and `discrepancy` on any amount/status disagreement.

### 2.6 Refunds reported success without refunding
- `PaymentGatewayManager.processRefund` generated a refund ID and returned `success: true`
  without calling any provider API. It now returns failure stating that manual disbursement is
  required and that the payment has **not** been refunded.

### 2.7 Invented STS tokens on token purchases
- The payment callback minted a random local "token code" and priced energy at a hardcoded
  45 c/kWh tariff. Token purchases without valid `energyKwh` metadata are now rejected for manual
  review, and an issued row is recorded as `pending_issuance` (no fake code presented as vendable),
  idempotently per payment.

### 2.8 P2P acceptance was treated as settlement
- Accepting an offer immediately marked both sides `executed` — energy and money "moved" with no
  payment. Acceptance now atomically claims a `pending`, unmatched offer, records the
  counterparty, creates the buyer leg as `pending`, tags both `settlement: 'awaiting_payment'`,
  and tells the caller payment + delivery confirmation are still required.

### 2.9 Billing-grade telemetry was self-reported
- An asset owner could POST arbitrary meter readings, which feed billing, NTL detection and
  settlement. Ingestion now requires registered-device credentials (`x-device-id` / `x-device-key`,
  scrypt + `timingSafeEqual`) bound to the asset.

### 2.10 Payment QR codes were unsigned
- QR payloads were plain JSON: amount, recipient and bill ID could be edited and still parsed as
  valid. Payloads are now HMAC-signed (`QR_SIGNING_SECRET`, required — no unsigned fallback),
  tampering is rejected, and the issuing user is bound into the payload.

### 2.11 Settlement hash chain could silently fork
- `createEvent` read the chain tip then inserted, with no uniqueness on `sequence_number`, so two
  concurrent writers produced two events at the same height each chaining from the same hash —
  both verifying "valid" in isolation. `sequence_number` and `previous_hash` are now unique
  (migration `0002`), and the losing writer retries against the new tip.

### 2.12 Duplicate referral rewards
- `processReferralReward` checked `status !== 'rewarded'` then inserted, so concurrent calls both
  paid out. The referral is now claimed with a conditional update inside a transaction before the
  reward row is inserted, and a failed insert raises instead of returning `id: 0`.

### 2.13 Wallet balance ignored completed top-ups
- Derived balance was `payments − billings − token purchases`; wallet top-ups never create a
  `payments` row, so a gateway-confirmed top-up left the balance unchanged (and auto top-up would
  refire indefinitely) while the snapshot looked authoritative. Top-ups are now a credit term
  (`top_ups_completed_cents`, migration `0002`).

### 2.14 Fabricated inputs that could trigger real payouts
- `simulateGridStress` invented grid conditions and called the real DR trigger path, dispatching
  compensated events. Disabled in production.
- `ALLOW_MOCK_WEATHER` could substitute generated irradiance for real weather in production,
  feeding solar-yield and DR forecasts. Now ignored in production.
- Community-energy frequency/voltage referenced undefined variables and mixed units; corrected to
  mHz/mV and reported as null when there is no telemetry.
- NTL risk lookups reported a flag's signals as "no divergence / bypass not detected" when the
  evidence blob was absent; unevaluated checks are now reported as unevaluated.
- ML forecast bounds were computed from a null confidence (`NaN` rendered as a number); null
  confidence now yields null bounds, and unmeasured model metrics render as "not measured".
- Gateway amount conversion rounded partial units to a different charge than
  `payments.amount`; amounts that cannot be charged exactly are rejected.

---

## 3. Open risks (not fixed — require product/integration decisions)

| # | Risk | Severity | Why it is open |
| --- | --- | --- | --- |
| 1 | STS token vending is not integrated: purchases persist `pending_issuance` with no vending, retry or refund workflow | High | Needs a certified vendor integration; faking it is what this audit removed |
| 2 | P2P settlement has no completion path: `trades.status` has no `matched`/`awaiting_payment` value, and other services still read `executed` as settled | High | Needs a schema + settlement-workflow decision |
| 3 | Refunds and DR compensation payouts require manual disbursement | High | No provider disbursement API is integrated |
| 4 | Device credential provisioning: `mqttPasswordHash` population and rotation are unverified; telemetry still rides the user-authenticated tRPC route rather than a dedicated device endpoint | Medium | Needs a device-identity design |
| 5 | Reconciliation assumes provider amount units/status semantics that were not validated against live sandboxes | Medium | Requires gateway sandbox credentials |
| 6 | Webhook raw-body preservation and signature coverage for Airtel/Tigo were not verified end to end | Medium | Requires provider sandbox callbacks |
| 7 | Callback payloads are typed `any` in several handlers | Medium | Needs per-provider schemas |
| 8 | No integration tests against a real MySQL/Redis/Kafka/Temporal stack; money paths are only unit-tested | Medium | Needs CI service containers |
| 9 | Blockchain anchoring, optimization, edge orchestration and analytics services still contain simulation-grade logic (honest about it, but not production evidence) | Medium | Product decision on what must be real |
| 10 | Operational gaps: secret management/rotation, alert routing (`performance-alerting` TODO), migration rollback story | Medium | Deployment work |
| 11 | `services/mqtt-fluvio-bridge` had never compiled: it was written against `github.com/infinyon/fluvio-client-go v0.14.0`, a module that does not exist (proxy.golang.org 404; GitHub prompts for credentials), so no telemetry record ever reached a stream. **Fixed**: `internal/stream` now implements two real transports — Kafka (`segmentio/kafka-go`, synchronous acknowledged writes to the topics the Node services already use) and Fluvio (`fluvio produce` via the CLI, the only Fluvio integration available to Go) — selected by `stream.transport`, with startup topic verification and no silent no-op path | Fixed | Neither transport has been exercised against a live cluster in CI; end-to-end delivery still needs an integration test with a broker |

The Go orchestrator also did not compile before this PR (unused `context`/`fmt` imports, `dapr` `SaveState` arity,
`workflow.RetryPolicy` / `workflow.NewApplicationError` which live in `go.temporal.io/sdk/temporal`), so its Temporal
workflows had never been built or run. Those are fixed here; `go build ./... && go vet ./...` now pass for
`orchestrator/`, and `orchestrator/go.sum` is committed.

---

## 4. Verification

```
tsc --noEmit                 # clean
vitest run                   # 3 files, 36 tests passed
vite build && esbuild ...    # succeeded
```

New regression tests (`server/fund-flow-hardening.test.ts`) cover gateway-environment refusal in
production, exact-amount conversion, QR signing/tamper rejection and device-secret verification.
`pnpm-lock.yaml` was regenerated because it was already out of date with `package.json`
(`helmet`, `express-rate-limit` were missing), which broke `--frozen-lockfile` installs.

## 5. Required environment variables introduced

| Variable | Purpose | Failure mode when unset |
| --- | --- | --- |
| `PAYMENT_GATEWAY_ENVIRONMENT` | `sandbox` or `production` gateway selection | Throws in production |
| `QR_SIGNING_SECRET` (≥32 chars) | HMAC key for payment QR payloads | QR generation and parsing throw |
