---
name: testing-grid-protocols
description: How to bring up and end-to-end test the grid-protocol layer (TS ingest at /api/grid/*, Go gridd OCPP 1.6J/OpenADR/2030.5, Rust modbus-poller) locally, including MySQL, HMAC signing, a fake OCPP charge point and a fake Modbus TCP device.
---

# Testing the grid-protocol layer locally

## Environment
- `pnpm install` requires `COREPACK_INTEGRITY_KEYS=0` (corepack keyid failure otherwise).
- MySQL is required for every `/api/grid/*` ingest route. A container works:
  `docker run -d --name vpp-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=vpp -p 3306:3306 mysql:8`
  then set `DATABASE_URL=mysql://root:root@127.0.0.1:3306/vpp` in `.env` and run `npx drizzle-kit migrate`
  (applies `0003_grid_protocol_tables.sql`).
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

## Gotchas
- `gridd`'s `call_timeout` (config.yaml) controls how long a silent charge point takes to surface a 502.
- OCPP `transactionId` is the `charging_sessions.id`; to prove it is not invented, check the DB row id.
- SoC meter samples must persist as a plain 0-100 percentage in `charging_sessions.end_soc_percent`;
  out-of-range values should be rejected with HTTP 400 and surface as an OCPP CALLERROR.
- Real charge-point hardware, a real OpenADR VTN, a real IEEE 2030.5 server and physical Modbus RTU cannot be
  tested locally; state them as gaps rather than faking them.

## Devin Secrets Needed
None. All credentials used locally (`GRID_PROTOCOL_SHARED_SECRET`, charge-point basic auth password, MySQL
root password) are test values you generate yourself.
