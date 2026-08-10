# VPP Mockware Triage Catalogue

## Critical Severity (Production Risks)
These represent simulated logic that would silently execute fake operations instead of real ones.

1. **Payment Worker (`workers/payment-worker/main.py`)**
   - `initiate_payment`: Returns hardcoded success response instead of calling gateway API.
   - `query_payment_status`: Returns hardcoded "completed" status.
   - `process_refund`: Returns `True` without executing refund.
   - `send_payment_notification`: Returns `True` without sending anything.

2. **DR Worker (`workers/dr-worker/main.go`)**
   - `SendNotificationsActivity`: Returns success without sending.
   - `MonitorComplianceActivity`: Empty stub returning nil.
   - `CalculateCompensationActivity`: Empty stub returning nil.

3. **Trading Worker (`workers/trading-worker/main.py`)**
   - Has mock logic for available energy and executing trades.

4. **Blockchain Audit (`server/services/blockchain-audit.ts`)**
   - `MockBlockchainProvider` uses `setTimeout` and random hash generation to simulate blockchain submission.
   - Hedera and Polygon providers are empty stubs throwing errors.

5. **Settlement Ledger (`server/services/settlement-ledger.ts`)**
   - `anchorToBlockchain`: Returns simulated anchor with a deterministic hash instead of real blockchain integration.

6. **MPesa Webhook (`server/routers/mpesa-webhook.ts`)**
   - Post-payment actions (token generation, notifications, billing updates) are commented out as `TODO`.

## High Severity (Misleading Data)
These inject fake data into the system, leading to incorrect analytics and decisions.

1. **Telemetry Simulation (`server/_core/websocket.ts`)**
   - `startTelemetrySimulation` runs every 5 seconds, injecting random `Math.random()` values into the production database for power, voltage, current, etc.

2. **Price Prediction (`server/ml/price-prediction.ts`)**
   - `predictPrices` uses `Math.random()` to generate price multipliers.
   - `calculatePrice` adds random variation `price *= (0.98 + Math.random() * 0.04)`.

3. **Weather API (`server/services/weather-api.ts`)**
   - `generateMockForecast` generates fake weather data using `Math.random()` if the API key is missing.

4. **Redis Cache Metrics (`server/integration/redis-cache.ts`)**
   - `getMetrics` and `getPerformance` return hardcoded random response times.

5. **Token Generation (`server/routers/payments.ts`, `server/webhooks/payment-callbacks.ts`)**
   - STS tokens are generated using `Math.random()`.

6. **Device Password (`server/routers/devices.ts`)**
   - `hashPassword` returns a placeholder `hashed_${password}` instead of actually hashing.
   - `generateSecurePassword` uses `Math.random()`.

## Medium Severity (Incomplete Workflows)
1. **DR Event Activities (`server/workflows/dr-event-activities.ts`)**
   - `monitorDRParticipationActivity` is a placeholder returning `{ success: true }`.

2. **Compliance Automation (`server/services/compliance-automation.ts`)**
   - Default case returns a `CHECK_NOT_IMPLEMENTED` finding.

3. **Payment Workflow (`server/workflows/payment-workflow.ts`)**
   - Uses `setTimeout` for simulated sleep instead of Temporal's sleep mechanism.
