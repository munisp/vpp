# VPP Mockware Sweep & Production-Readiness Audit — 2026-08-11

This document supersedes the status claims in `MOCKWARE_REMEDIATION_REPORT.md` (commit `72cf665`).
An independent multi-agent audit found that report's "all mockware eliminated" claim to be **false**:
it fixed 17 patterns but left ~60 further instances, including the most dangerous ones (fake payment
confirmations, fabricated compliance records, settlement without delivery verification).

## Audit method
Five parallel read-only auditors shard-scanned the full tree (server core/routers, server services/ML,
client/mobile, workers/orchestrator/infra, production-readiness). Every finding cites file:line evidence.
Fixes were applied by six parallel coders on disjoint file sets, then an independent verifier re-swept
the tree (gate verdict: NO-GO → gate items fixed → GO).

## What was found and fixed (highlights)

### CRITICAL — financial fabrication (all fixed)
| Finding | Fix |
|---|---|
| `_core/paymentGateway.ts` returned fake M-Pesa/Airtel/Tigo transaction IDs; `verifyPaymentStatus` always "completed"; `generateSTSToken` used `Math.random` | Full rewrite: real Daraja/Airtel/Tigo API calls; `*_NOT_CONFIGURED` throws; status queries map real gateway codes (errors → `pending`, never `completed`); STS token throws `STS_VENDING_NOT_CONFIGURED` — callers record `pending_issuance` instead of a fabricated code |
| `payments.verify` initialized verification to `completed` for bank/card — any user could mark their own payment paid and receive energy tokens | Non-gateway methods now require admin reconciliation (FORBIDDEN); `energyKwh \|\| 10` fabrication removed (BAD_REQUEST) |
| `_core/qrStatusUpdater.ts` cron randomly flipped pending QR payments to completed/failed with fake `GW-` refs every 5 min | Real gateway status resolution via `PaymentGatewayManager`; errors leave `pending`; unresolvable → skip |
| `compliance-automation.ts` persisted unimplemented checks (`market_rules`, `environmental`) as **compliant** and published "pass" | Status `pending_review`, warning severity, never published as pass |
| Refunds: `payment-gateway-service.ts` marked payments `refunded` with no gateway call; `payment-activities.ts` refund was a console.log stub | Real M-Pesa reversal API; unconfirmable refunds → `manual_review_required`, never auto-`refunded` |
| P2P trades settled `executed` + escrow "released" after a 1-second timer with no delivery verification (TS + Python trading workers) | Real telemetry verification (seller export ≥90% over delivery window); unverified → failed + escrow held; real `workflow.sleep` delivery windows |
| `payment-activities.ts` hardcoded `'sandbox'` for all gateway calls | `PAYMENTS_ENV` driven, defaults `production` |
| Go orchestrator: fabricated completed payment transactions feeding TigerBeetle credits; hardcoded P2P offer (`seller-1`); hardcoded DR performance converted to real credits | Deleted/replaced: real gateway POST when configured else loud error; real order-book query; telemetry-computed DR performance; ledger activities fail loudly until a reviewed TigerBeetle integration exists |
| DR compensation/enrollment/notification SQL targeted nonexistent tables and swallowed errors (compensation silently dropped) | Rewritten against real schema (`drResponses`, `drCompensation`, `alerts`, `demandResponseEvents`); all errors propagate to Temporal |
| Trading worker "assume successful delivery" + fictional escrow (release flipped any same-amount payment to `completed`) | Telemetry-verified delivery; escrow = honest bookkeeping hold by row ID; disbursement explicitly a separate payments-subsystem step |
| QRScanner.tsx toasted "Payment processed successfully!" with zero payment execution | Wires to real `payments.initiate` (user picks M-Pesa/Airtel/Tigo + phone); success only on gateway acceptance |

### HIGH — fabricated data presented as real (all fixed)
- `orchestrator.ts` router returned "workflow started" for phantom in-memory executions → real Temporal dispatch, `NOT_IMPLEMENTED` where no workflow exists, `INTERNAL_SERVER_ERROR` on dispatch failure.
- `biometric.ts` accepted any WebAuthn assertion → fail-closed verification (server challenges, rpIdHash, ES256 signature verify, counter checks).
- Weather API silently returned random forecasts on any API failure → mock only behind explicit `ALLOW_MOCK_WEATHER=true`, payload marked `mock:true`.
- ML price model reported invented accuracy (75%/R² 0.65) and untrained predictions from a hardcoded intercept → null metrics, `trained:false`, empty predictions until trained.
- Forecast MAE/RMSE/MAPE algebraically derived from the model's own confidence → null until real backtest.
- Hardcoded economics: EV charging prices, community allocation prices (45/55), executed-trade prices (35–70), `currentPrice = 45` revenue insights, orchestrator 0.15 price / 0.5 consumption / 75% battery SOC → all sourced from `marketPrices`/telemetry or throw.
- Optimization engine marked setpoints "dispatched" with no device command → real MQTT publish; failure → `dispatchStatus:'unsent'`.
- Fake notifications: console-log email/SMS/push returning `true`; hardcoded admin KPI emails (`revenue 4,500,000`); referral emails to `user_N@vpp.platform` → real SMTP/web-push/Africa's Talking, real aggregations, real user emails.
- Web client: fabricated referral leaderboard (10 fake users), hardcoded empty payment history, fake "Preference updated" toasts, fake biometric registration, hardcoded "+2.5%" market badge → all wired to real tRPC endpoints (new: `payments.list/listTokens/getBalance`, `trading.getEarnings/getMarketPrices`, `p2pTrading.*` router).
- Mobile: 8 screens called phantom endpoints rendering fabricated zeros; dead toggles for auto-sell/notifications/DR opt-in; empty auth headers; cookie/Bearer mismatch → all rewired to real procedures; auth aligned to server cookie scheme.

### Security fixes applied alongside
- `mpesa-webhook` `testPayment`/`queryStatus` were `publicProcedure` (anyone could fire real STK pushes) → `adminProcedure`.
- Webhook signature verification (HMAC-SHA256, fail-closed in production) on `/api/webhooks/{mpesa,airtel,tigo}`.
- WebSocket: ` cors: '*'` + client-supplied userId → verified-session handshake auth, server-derived identity.
- `JWT_SECRET ?? ""` → production fail-fast; dev ephemeral random secret.
- Demo-mode auth bypass hard-gated out of production (both server context and client `useAuth`; demo user is no longer admin).

## Honest current state (deliberate loud failures — not bugs)
- STS token vending: throws until a certified IEC 62055-41 vending provider is integrated; tokens sit at `pending_issuance`.
- Hedera/Polygon anchoring: throws at boot when selected (unimplemented); local anchoring is an honest SHA-256 commitment labeled `local_committed` with `0xlocal_` hashes.
- Temporal workflows `startDRForecasting`, `processQRPayment` (router), `startTelemetryMonitoring`, `processAlert`, leaderboard/achievement dispatch: `NOT_IMPLEMENTED`.
- Go orchestrator money movement (TigerBeetle): disabled loudly until a reviewed ledger integration; module needs `go mod tidy` on first build (two go.mod additions).
- Unsent device dispatches surface as `dispatchStatus:'unsent'`; unconfirmed microgrid islanding transitions require operator confirmation.

## Remaining production gaps (from the readiness review — NOT mockware)
1. **Migrations**: 22 SQL files at `drizzle/` vs 2 journal entries; `drizzle/migrations/` empty; deploy script uses destructive `drizzle-kit push`. New columns from this wave (`assets.approvalStatus`, `dr-segmentation.responseTimeScore` nullable, `tokens` enum `pending_issuance`) need real migrations.
2. **Ops**: no `.github/` CI; no Dockerfile for server/client/orchestrator; existing Dockerfiles run as root, no HEALTHCHECK; missing `go.sum` (orchestrator, mqtt-fluvio-bridge); no graceful shutdown handlers; compose files carry demo credentials (Keycloak `start-dev` admin/admin, minioadmin, Grafana admin).
3. **Hardening**: no rate limiting/helmet; 50MB JSON body limit; `trust proxy` unset.
4. **Docs-honesty corrections**: `PRODUCTION_DEPLOYMENT_CHECKLIST.md` claims "TypeScript compilation successful (0 errors)" / "PM2 ecosystem ready" — unverified in this environment; `DEPLOYMENT.md:227` `pm2 start … --interpreter=node` cannot run TS; `CONSOLIDATED_TEST_SECURITY_REPORT.md` "pnpm audit — 0 vulnerabilities" is not reproducible here. Treat those documents as aspirational until CI exists.
5. **Tests not executed**: `node_modules` absent; Go toolchain absent. All fixes verified by esbuild/py_compile/static review + pattern-matching against existing real code. Run `pnpm install && pnpm check && pnpm test`, `go build ./...`, and `pytest workers/` in CI before deploy.

## Production-readiness score
| Area | Before | After |
|---|---|---|
| Mockware / data honesty | 2/10 | 8/10 (sweep clean; loud-failure design) |
| Security | 3/10 | 6/10 |
| Build/ops | 2/10 | 3/10 (manifests restored; CI/Docker/migrations still missing) |
| **Overall** | **3/10** | **6/10 — honest, but not yet deployable** |

The platform no longer lies: every former fabrication path now computes from real data or fails loudly.
The remaining gap to production is operational (migrations, CI, Docker, hardening), not behavioral.
