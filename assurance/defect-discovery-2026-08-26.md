# Defect Discovery and Remediation Record — 2026-08-26

**Method:** Evidence-bound source audit following the attached defect-discovery brief. Findings are marked **CONFIRMED** only where the reachable route and complete affected code path were read. This record documents source-level evidence; it does not claim provider, ledger, device, or deployment execution that was not performed.

> **Release decision:** **BLOCKED.** The in-scope source defects below are remediated and tested, but release certification remains blocked by the residual register: schema-gated payment idempotency work, two vendor-unpatched Metro advisories, remaining dependency review, CSP staging rollout evidence, and real non-production integration/recovery exercises.

## Executive summary

The audit confirmed seven in-scope defects on reachable application paths. A production-configured Airtel integration could target UAT; a wallet could subtract platform value rather than customer payable value; automatic wallet checks could duplicate provider prompts; pending asset approval did not prevent P2P offers; and the application disabled CSP due to inline scripts. The payment-processing route also contacted a provider before any durable payment attempt existed, allowing a crash or ambiguous provider result to leave no reconciliation record.

All seven source-level defects were remediated without a schema migration. The fixes fail closed in production, preserve ambiguous money outcomes for reconciliation, constrain P2P offers to approved assets, correct cents arithmetic, serialize automatic top-up initiation, and enforce a strict production CSP after externalizing inline scripts.

| Status | Count | Notes |
|---|---:|---|
| CONFIRMED and remediated | 7 | DCD-001 through DCD-007 below. |
| CONFIRMED but schema-gated | 2 | Durable payment idempotency key / provider-attempt uniqueness remain outside the no-schema constraint. |
| External-blocked | 5 | Real provider, ledger, event, device, and recovery proof cannot be fabricated from source review. |
| SUSPECTED | 0 | No untraced pattern matches are presented as defects. |

## Ground-truth maps

The map is limited to paths read during this audit; its coverage is not a claim of full deployment certification.

| Map | Confirmed scope | Evidence | Coverage / limitation |
|---|---|---|---|
| Service map | Express application, tRPC router registry, payment webhooks, P2P router, wallet router, and production static serving. | `server/_core/index.ts:50-175`; `server/routers.ts:103-209`; `server/_core/vite.ts:50-67`. | Partial. Polyglot workers/services require provisioned topology verification. |
| Money map | `payments`, `billings`, `tokens`, `wallet_top_up_attempts`, P2P `trades`, and payment callback transitions. | `drizzle/schema.ts:232-282`; `drizzle/grid-intel-schema.ts:138-210`; `server/routers/payments.ts`; `server/routers/paymentProcessing.ts`; `server/services/energy-wallet.ts`. | Partial. TigerBeetle/PostgreSQL integration was not available. |
| Trust-boundary map | Payment provider initiation/status, payment callbacks, wallet top-up, P2P payment start, external analytics, PWA service-worker registration. | `server/payment-gateways/index.ts`; `server/webhooks/payment-callbacks.ts`; `server/_core/index.ts`; `client/index.html`. | Callback HMAC verification is present in `server/webhooks/verify-signature.ts`; live provider validation remains external. |
| Gate map | Payment environment, webhook HMAC, admin edge controls, business verification, and asset approval. | `server/payment-gateways/environment.ts`; `server/webhooks/verify-signature.ts`; `server/routers/nextgen/edge.ts`; `server/services/p2p-participants.ts`; `server/routers/p2p-trading.ts`. | Partial. No full identity-provider or device authorization exercise was run. |
| Config map | Payment environment, Airtel production endpoint, analytics configuration, and production CSP. | `server/payment-gateways/environment.ts`; `server/payment-gateways/airtel.ts`; `server/_core/csp.ts`; `server/_core/index.ts`. | Configuration values and deployment secrets were not available for verification. |

## Confirmed findings and remediation

| # | Family | Title | Evidence before remediation | User-facing lie / blast radius | Remediation and evidence |
|---:|---|---|---|---|---|
| DCD-001 | F1, F16 | Production Airtel requests used the UAT endpoint. | Former `server/payment-gateways/airtel.ts:27-31` returned `https://openapiuat.airtel.africa` for both environments; the live payment-processing router is registered at `server/routers.ts:155`. | A production payment flow could be presented as live while targeting a non-production provider environment. | `server/payment-gateways/airtel.ts:27-53` now requires `AIRTEL_PRODUCTION_BASE_URL`, rejects non-HTTPS/credential-bearing values, and rejects the UAT origin. |
| DCD-002 | F4, F12 | Payment-processing contacted provider before a durable payment attempt existed. | Former `server/routers/paymentProcessing.ts:59-120` called `PaymentGatewayManager.initiatePayment` before inserting `payments`. | A crash or ambiguous response after a provider prompt could create an untracked charge with no reconciliation path. | `server/routers/paymentProcessing.ts:56-237` now checks gateway configuration, persists a pending row under a per-invoice advisory lock before provider I/O, retains ambiguous outcome metadata, and records Temporal handoff failure. |
| DCD-003 | F13 | Wallet debited platform total rather than customer payable share. | Former `server/services/energy-wallet.ts:83-105` summed `billings.totalValue`; payment initiation charges `billings.consumerShare` in `server/routers/paymentProcessing.ts:56-57`. | A fully paid invoice could still show a negative balance and cause an automatic payment prompt. | `server/services/energy-wallet.ts:83-123` now sums `consumerShare` and delegates cents arithmetic to `deriveWalletBalanceCents`. |
| DCD-004 | F4, F5 | Concurrent automatic wallet checks could initiate duplicate provider prompts. | Former `server/services/energy-wallet.ts:212-230` read the balance and called initiation; former initiation persisted the attempt only after gateway I/O. | Two concurrent checks could both see low balance and trigger separate provider requests. | `server/services/energy-wallet.ts:253-296` uses `pg_advisory_xact_lock(userId)`, detects an existing initiated auto attempt, and retains manual top-ups as explicit user actions. |
| DCD-005 | F3 | Unapproved assets could publish P2P energy offers. | `drizzle/schema.ts:129-144` defaults assets to `active` and `pending`; former `server/routers/p2p-trading.ts:148-158` checked active status only. | A user could advertise delivery based on an asset that the platform had not approved. | `server/routers/p2p-trading.ts:148-166` now requires a caller-owned asset with both `status='active'` and `approvalStatus='approved'`. |
| DCD-006 | F9, F16 | Application CSP was explicitly disabled. | Former `server/_core/index.ts:62-68` used `helmet({ contentSecurityPolicy: false })`; `client/index.html:30-47` contained inline script and environment-expanded third-party script source. | Browser script execution policy was absent despite other security headers, increasing injection impact. | `client/index.html:29-31` now uses only external scripts; `client/src/sw-register.ts` preserves PWA registration; `server/_core/csp.ts` validates analytics configuration and builds strict directives; `server/_core/index.ts:67-85` enforces CSP in production and serves a same-origin analytics loader. |
| DCD-007 | F16 | Rate-limit reset time was reconstructed from separately sampled local time and Redis TTL. | `server/rate-limit-store.test.ts:150-167` intermittently observed a one-millisecond forward reset value while `server/services/rate-limit-store.ts:155-160` rebuilt the timestamp from `Date.now() + ttl`. | A fixed window could appear to slide in rate-limit headers, and the full integrity suite was nondeterministic. | `server/services/rate-limit-store.ts:96-102,155-177` records the first observed reset instant per local key and never reports a later instant for that Redis window; `resetKey`/`resetAll` clear that metadata. |

## Negative results

The following sampled checks were traced and did not produce a confirmed defect in the audited code paths.

| Family | Checked path | Result |
|---|---|---|
| F5 replay | Payment webhooks | Live routes apply `verifyWebhookSignature` before the payment limiter and handler in `server/_core/index.ts:161-168`; callback state transition is conditional on pending status in `server/webhooks/payment-callbacks.ts:225-247`. |
| F8 authorization | Edge control | Edge procedures are admin-gated, with a regression test in `server/edge-router-authorization.test.ts`. |
| F1 phantom refunds | Gateway manager | `processRefund` explicitly reports `success: false` and says funds are not returned where no provider disbursement API exists, `server/payment-gateways/index.ts:276-298`. |
| F1 P2P completion | Marketplace match | Match state remains `awaiting_payment`; it does not claim settlement on offer acceptance, `server/routers/p2p-trading.ts:18-26,265-274`. |

## Composition check

A potential money-loss composition was traced: **incorrect wallet debit term × concurrent auto-top-up initiation × live mobile top-up UI**. The wallet screen invokes `energyWallet.requestTopUp` and displays provider-prompt language at `mobile/src/screens/WalletScreen.tsx:92-116`; the server previously used `totalValue` rather than the payable share and persisted automatic attempts after provider I/O. DCD-003 corrects the ledger term and DCD-004 serializes the automatic attempt path, breaking both links in this chain.

## Residual register

| ID | Severity | Status | Owner / trigger to revisit |
|---|---|---|---|
| RES-001 | High | Schema-gated | Payment-processing uses a per-invoice advisory lock, but true request retry idempotency requires a client idempotency key plus a database uniqueness constraint. Obtain explicit schema approval before adding it. |
| RES-002 | High | Schema-gated | Manual wallet top-ups are intentionally repeatable purchases. Retry-safe idempotency requires a durable client key and database constraint, not a request-body heuristic. Obtain explicit schema approval. |
| RES-003 | High | External-blocked | Real payment-provider sandbox, PostgreSQL/TigerBeetle, Kafka/Temporal, provider callback, and device simulator tests have not been executed. Revisit when isolated credentials/topology are approved. |
| RES-004 | High | External-blocked | Production CSP is code-enforced, but staged browser/PWA/reporting evidence and approved analytics/origin inventory remain required before release certification. |
| RES-005 | High | Vendor-blocked | Mobile Metro retains two unpatched `image-size@1.2.1` high advisories. Follow the separately supplied Metro mitigation runbook and upgrade/patch when a verified upstream path exists. |
| RES-006 | Low | Vendor-blocked | Root `elliptic@6.6.1` via Keycloak/JWK remains without a published patch in the prior production audit. |

## Verification evidence

| Gate | Result |
|---|---|
| Focused regression suite | `pnpm exec vitest run server/_core/csp.test.ts server/payment-processing-remediation.test.ts server/energy-wallet-remediation.test.ts server/p2p-asset-approval.test.ts`: 9 passed. |
| Type check | `pnpm check`: passed. |
| Full root suite | `pnpm test`: 66 files passed; 721 passed, 10 skipped. |
| Production web build | `pnpm build`: passed. Existing vendor-chunk and browser-metadata warnings remain. |
| Secret scan | `GITLEAKS_BIN=/home/ubuntu/toolcache/gitleaks/gitleaks ./scripts/secret-scan.sh`: working tree and history scans passed. |

## Scores and completion gates

The attached brief’s completeness gates are **not all satisfied**, because a source audit cannot validate all external provider, deployment, device, and recovery paths. This report therefore does not represent a release certificate.

| Category | Source-audit score | Blocking reason |
|---|---:|---|
| F1–F5 money execution, atomicity, replay | 78/100 | In-scope defects remediated; durable cross-request idempotency still schema-gated and provider proof is external. |
| F6–F10 authentication, authorization, input, secrets | 72/100 | Sampled routes and webhooks were reviewed; full account takeover and identity-provider exercise not performed. |
| F11–F15 lifecycle, arithmetic, integrity, observability | 74/100 | Wallet/P2P/payment defects remediated; database and production evidence remain unavailable. |
| F16 build, deploy, environment | 68/100 | Build passed and Airtel/CSP are hardened; deployment, recovery, and service topology remain external-blocked. |
| Composite | **73/100 — blocked** | No real integration/recovery proof; residual schema-gated and vendor-blocked risks remain. |
