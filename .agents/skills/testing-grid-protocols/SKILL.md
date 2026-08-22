---
name: testing-grid-protocols
description: How to bring up and end-to-end test the grid-protocol layer (TS ingest at /api/grid/*, Go gridd OCPP 1.6J/OpenADR/2030.5, Rust modbus-poller) locally, including PostgreSQL, HMAC signing, a fake OCPP charge point and a fake Modbus TCP device.
---

# Testing the grid-protocol layer locally

## Environment
- `pnpm install` requires `COREPACK_INTEGRITY_KEYS=0` (corepack keyid failure otherwise).
- PostgreSQL is required for every `/api/grid/*` ingest route. A container works:
  `docker run -d --name vpp-postgres -e POSTGRES_PASSWORD=vpp -e POSTGRES_USER=vpp -e POSTGRES_DB=vpp -p 5432:5432 postgres:16`
  (if port 5432 is already taken by a host `postgresql` service, use that service instead of a container).
  Then set `DATABASE_URL=postgresql://vpp:vpp@127.0.0.1:5432/vpp` in `.env` and run `npx drizzle-kit migrate`
  (applies `0000_postgres_baseline.sql`, ~97 tables).
- Branches cut from `main` may still be **MySQL-era** (`server/db.ts` imports `drizzle-orm/mysql2`, migrations
  `0000_baseline.sql` … `0003_grid_protocol_tables.sql`). MySQL is not a dead end: reuse/start the container
  `docker run -d --name vpp-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=vpp -p 3306:3306 mysql:8`, set
  `DATABASE_URL=mysql://root:root@127.0.0.1:3306/vpp`, run `npx drizzle-kit migrate` (~92 tables) and query with
  `docker exec vpp-mysql mysql -uroot -proot -N -B -e "use vpp; ..."`. On MySQL the columns are a mix: schema
  tables use camelCase (`payments.transactionId`, `tokens.paymentId`) while some newer tables are snake_case
  (`payment_gateway_logs.request_type`, `is_active`) — check `describe <table>` rather than guessing, and note
  no quoting is needed. Keep both DBs around so you can switch per branch.
- Raw SQL in seed/verification scripts must double-quote camelCase identifiers (`"userId"`, `"deviceId"`) —
  unquoted identifiers fold to lowercase and fail with `column "userid" does not exist`.
- Seed the minimum rows before testing: a `users` row, `charging_stations.station_id` (set `v2g_capable`),
  `ocpp_id_tags` (one accepted, one blocked), an active `drParticipants` row with autoOptIn, an `assets` row
  and a `devices` row whose `deviceId` matches the modbus poller config. Without these, ingest returns 404s
  that look like bugs but are the intended "no auto-provisioning" behaviour.
- `.env` also needs `GRID_PROTOCOL_SHARED_SECRET` (>=32 chars) and `GRID_PROTOCOL_SERVICE_URL`
  (e.g. `http://127.0.0.1:9100`, where `gridd` listens).
- The server logs Redis/MQTT connection warnings when those services are absent; grid routes still work.

## Auth used in both directions
HMAC-SHA256 over the exact string `"<unix seconds>.<raw body>"` with the shared secret, sent as
`x-grid-timestamp` / `x-grid-signature`, 5-minute window. The same scheme guards gridd's `/admin/*` API.
Sign the *exact* bytes you send — re-serializing the JSON breaks the signature.

## Useful harness pattern
Small Node scripts are enough and avoid needing the UI:
- signed/unsigned ingest driver (matrix: unsigned, tampered body, stale ts, fresh ts, valid, unknown id);
- a real OCPP 1.6J WebSocket client (`ws` with subprotocol `ocpp1.6` and HTTP basic auth in the URL/headers)
  driving BootNotification/Heartbeat/StatusNotification/Authorize/StartTransaction/MeterValues/StopTransaction,
  plus modes that answer `Rejected` or stay silent so outbound admin commands can be tested;
- a fake Modbus TCP server that returns crafted registers and a Modbus `IllegalDataAddress` exception for one
  address, to prove failed registers are omitted rather than published as 0.
Run TypeScript drivers with the repo's `node_modules/.bin/tsx` and a `.mts` extension — a `.ts` file under a
CommonJS `package.json` fails with "Top-level await is currently not supported with the cjs output format".

## Money paths (payments + settlement ledger)
- The M-Pesa callback route is `POST /api/webhooks/mpesa` and needs **no** webhook signature in development
  (`server/webhooks/verify-signature.ts` only warns when no secret is configured), but it *does* need an
  **active sandbox credential row**: `PaymentGatewayManager` throws `No sandbox credentials found for mpesa`
  otherwise. Seed one through the product code (`savePaymentCredentials(...)` from
  `server/payment-credentials-db.ts`, which encrypts them) and then `update payment_credentials set
  is_active='true'`. Inserting raw JSON directly fails to decrypt.
- Amount semantics (as of the PR that removed the double conversion): every adapter normalises the provider's
  **major units to cents** (`mpesa.ts` `Amount * 100`, `airtel.ts` `amount * 100`, `tigo.ts`), and
  `updatePaymentFromCallback` compares that value directly. So for a payment of `N` cents the genuine provider
  amount is `N / 100` (e.g. `Amount: 5000` settles a 500000-cent payment). If you see
  `Amount mismatch on payment X: callback <100*expected> vs expected ...` the ×100 is being applied twice again
  (the old bug); if you see a mismatch at exactly the amount you sent, your fixture amount is simply wrong.
- Good observable side effect for "post-payment actions ran exactly once": seed the payment as
  `paymentType='token_purchase'` with `metadata.energyKwh` (integer). The handler inserts exactly one `tokens`
  row per payment (`tokenCode = PENDING_ISSUANCE_<paymentId>`, unique), so a double-credit shows up as a second
  row or a unique-key error. `invoice` payments only touch `billings` when `billingId` is set.
- Payment lookup is by `payments.transactionId` **only**, and for M-Pesa that value is the
  `MerchantRequestID` (`server/_core/paymentGateway.ts` stores `data.MerchantRequestID`; the adapter falls back
  to it when a successful callback has no `MpesaReceiptNumber`). A failure callback (`ResultCode != 0`, no
  `CallbackMetadata`) therefore only matches when the fixture's `transactionId` is the MerchantRequestID — seed
  it that way or you will get a misleading `Payment not found for transaction: ...`. On trees that reject
  unmatched callbacks this brittleness becomes user-visible as an HTTP 404 instead of a silent log line, so a
  mis-keyed fixture looks like a product bug — check the fixture key first.
- Unmatched ("orphan") callbacks: on newer trees `updatePaymentFromCallback` throws `UnmatchedCallbackError` and
  each handler answers **HTTP 404** in that provider's failure envelope (M-Pesa
  `{"ResultCode":1,"ResultDesc":"Unknown transaction"}`, Airtel `status.code='404'`/`success:false`, Tigo
  `{"ResponseCode":"1",...}`) plus a `payment_gateway_logs` row `request_type='callback_unmatched'`,
  `status='failed'`, `error_message='unmatched_transaction: <id>'`, `payment_id` NULL. On older trees the same
  callback returned HTTP 200 `ResultCode 0 / Success`. Either way, **two success-shaped audit rows are still
  written before the payment lookup** — `request_type='callback'`/`status='pending'` (`payment-callbacks.ts`)
  and `request_type='CALLBACK'`/`status='success'` (`payment-gateways/index.ts`, which keys `status` off the
  *parsed provider* status, not off whether a payment matched). So assert on the `callback_unmatched` row, and
  never treat `status='success'` in that table (or the HTTP body) as evidence of settlement — always compare
  `payments`/`tokens` row counts before and after each callback.
- Airtel/Tigo are reachable locally without any network: `initialize()` is the base-class no-op
  (`payment-gateways/base.ts`) that just stores credentials, so `processCallback` works with dummy creds. Post
  `{transaction:{id,amount,status:'TS',msisdn}}` to `POST /api/webhooks/airtel`, and
  `{TransactionID,ReferenceID,Status:'COMPLETED',Amount,CustomerMSISDN}` to `POST /api/webhooks/tigo` (Tigo needs
  its own active `tigo_pesa` credential row; the adapter's lookup key is `TransactionID` while the handler's
  audit id is `ReferenceID || TransactionID`, so the two can name different ids).
  `PaymentReconciliationEngine` is *not* locally testable — it calls the provider's real `queryPaymentStatus`
  HTTP API.
- Replaying an identical callback is caught by the terminal-state guard (`already in terminal state ... skipping`)
  before the conditional `UPDATE ... WHERE status='pending'` runs, so the `rowCount === 0` branch needs genuine
  interleaving. Two parallel HTTP posts often serialise, but firing them from one shell with
  `(node pay.mjs a & node pay.mjs b & wait)` does sometimes win the race — the tell is
  `Payment N was settled concurrently, skipping post-payment actions`. Retry a few times before reporting it
  as unreachable.
- Settlement chain: build events with the real `settlementLedger.createEvent()`, then mutate a monetary column
  with raw SQL and call `verifyChain()`. Also try *laundering* the tamper (recompute the row's own `event_hash`
  from the v2 pre-image in `server/services/settlement-ledger.ts`) — the chain should still fail on the *next*
  event's `previous_hash`.

## Timezone checks
Run the server and drivers with `TZ=Asia/Kolkata` (or any non-UTC zone): `show timezone` on the app connection
must still be `UTC` (the pool passes `options: '-c timezone=UTC'`), and stored `payments.createdAt`,
`settlement_events.created_at`, `grid_protocol_instructions.start_time/received_at` must match `date -u`.

## Workers
- `workers/dr-worker` (Go) connects with `lib/pq` and a UTC DSN, then dials Temporal at `localhost:7233`; with
  `DATABASE_URL=...?sslmode=disable` it logs `[DB] Connected to database` and then fails on Temporal. That is
  enough to prove the DB path; the workflow logic needs a Temporal server.
- `workers/payment-worker` / `trading-worker` (Python) import `temporalio` and default `DB_SSLMODE=require`;
  locally you need `DB_SSLMODE=disable` and a venv with `requirements.txt` installed, plus Temporal. Report as
  gaps if Temporal is unavailable.

## Gotchas
- The TS server entrypoint is `server/_core/index.ts` (`pnpm dev`), not `server/index.ts`.
- Branch churn is common in this repo: verify the actual dialect of the checked-out tree before choosing a DB
  (`ls drizzle/migrations`, the driver import in `server/db.ts`, `dialect` in `drizzle.config.ts`) instead of
  trusting the branch description. A pg client pointed at MySQL fails with `error: received invalid response: 4a`,
  and a *stale server process* started with an older `.env` produces exactly that — always kill the pid holding
  :3000 (`ss -ltnp | grep :3000`) and restart after editing `DATABASE_URL`.
- `gridd` must be started with `GRID_PROTOCOL_SHARED_SECRET` exported, otherwise it exits with
  `platform.shared_secret must be at least 32 characters`.
- Keep TypeScript drivers that import product modules **inside the repo** (e.g. `/repo/xyz-harness.mts`);
  a driver in `/tmp` fails with `Cannot find package 'drizzle-orm'`. Copy them out and delete them afterwards
  so the tree stays clean.
- Do not put `pkill`/`pgrep -f <pattern>` in the same shell command that also matches the pattern — the shell
  kills itself (`exit -1`). Use a small wrapper script, and start long-lived fakes with
  `setsid nohup ... < /dev/null &` so they survive.
- A fake Modbus TCP server must size the reply as `8 + payload.length` bytes with the MBAP length field set to
  `2 + payload.length`; a one-byte-short frame makes the poller report `timed out after 2s` even though the
  fake device logs a successful reply.
- Schema-vs-code drift is cheap to check: `npx drizzle-kit check`, plus `drizzle-kit generate` against a copy of
  `drizzle/migrations` in `/tmp` (run from that directory, with a relative `out`) — "No schema changes" means the
  baseline matches the schema files.
- The app's API is tRPC under `/api/trpc/*` and requires a login (`Please login (10001)`), and the Vite dev
  middleware answers unknown `/api/...` GETs with `index.html` — so plain curl smoke tests of REST-looking paths
  prove nothing. Drive real behaviour through the grid routes, webhooks and service modules instead.
- `gridd`'s `call_timeout` (config.yaml) controls how long a silent charge point takes to surface a 502.
- OCPP `transactionId` is the `charging_sessions.id`; to prove it is not invented, check the DB row id.
- SoC meter samples must persist as a plain 0-100 percentage in `charging_sessions.end_soc_percent`;
  out-of-range values should be rejected with HTTP 400 and surface as an OCPP CALLERROR.
- Real charge-point hardware, a real OpenADR VTN, a real IEEE 2030.5 server and physical Modbus RTU cannot be
  tested locally; state them as gaps rather than faking them.

## Devin Secrets Needed
None. All credentials used locally (`GRID_PROTOCOL_SHARED_SECRET`, charge-point basic auth password, PostgreSQL
password) are test values you generate yourself.
