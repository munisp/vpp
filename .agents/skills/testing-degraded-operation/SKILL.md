---
name: testing-degraded-operation
description: How to bring up and end-to-end test the VPP degraded/offline execution layer (dependency observations, outages, capability refusals, degraded actions, member honesty surfaces) plus the Rust modbus-poller spool, on PostgreSQL.
---

# Testing the degraded-operation layer (PR #29 and later)

## Bring-up

Repo `.env` may carry a stale `DATABASE_URL` and `NODE_ENV`; always override both explicitly. Only a
`postgres://`/`postgresql://` DSN is accepted — anything else is refused at connect time by design.

```bash
export NODE_ENV=development PORT=3000
export DATABASE_URL="postgres://vpp:vpp@localhost:5432/vpp_degraded2"
export JWT_SECRET="<any 32+ char string>"
export GRID_PROTOCOL_SERVICE_URL="http://127.0.0.1:9100"   # leave nothing listening: absence is the evidence
export GRID_PROTOCOL_SHARED_SECRET="<shared secret>"
export DEGRADED_GUARD="observe"                            # or enforce
npx tsx server/_core/index.ts
```

Redis/MQTT/`gridd` warnings at startup are benign locally, and their genuine absence is what produces
`down`/`unknown` dependency states. Do not stub them — stubbing destroys the thing under test.

### Always confirm the branch you think you are testing is actually live on `:3000`

After a machine restart, or after checking out a new branch, an **old server process can survive on
`:3000` and silently serve pre-checkout code** — every assertion then describes the wrong revision.
`pkill -f 'tsx server/_core'` frequently misses the real listener (the child `node` PID), so find the
owner by port and kill that:

```bash
fuser -n tcp 3000            # prints the PID actually holding the port
kill <pid>; sleep 1; fuser -n tcp 3000   # confirm it is free before relaunching
```

Then prove the new code is live with a **response-shape probe** rather than trusting the restart. For
the Modbus ingest endpoint, current code answers `{"samples":1,"readings":1}` while pre-PR#30 code
answers `{"stored":1}`. Pick any field the branch renamed and assert on it before testing anything else.

### Background helpers must be started with `setsid`

The exec tool reaps plain `cmd &` children, so proxies/fakes die the moment the call returns. Launch
them detached and redirect output to a log:

```bash
setsid node proxy.mjs > proxy.log 2>&1 &
setsid node fake-modbus.mjs > fake-modbus.log 2>&1 &
setsid env RUST_LOG=info ./target/release/modbus-poller /path/to/config.toml > poller.log 2>&1 &
```

Beware `pkill -f 'modbus-poller'`: `-f` matches full command lines, so it also matches **your own shell
command** containing that string and kills the call before it runs. Use a bracket pattern
(`pkill -f 'release/modbus-pol[l]er'`) or kill by PID from `pgrep -af`.

The poller takes its config as a **positional** argument (`modbus-poller config.toml`); `--config` and
`--help` are both parsed as a path and fail with "reading configuration --help".

## Browser auth without fighting cookies

Setting the `app_session_id` cookie directly via devtools raises `SecurityError`. Instead run a tiny
reverse proxy that injects a JWT read from a file, and point the browser at the proxy:

- mint admin (users.id 1, role `admin`) and member (id 2, role `user`) JWTs to files
- proxy on `127.0.0.1:3100` → `127.0.0.1:3000`, adding `Cookie: app_session_id=<jwt>`
- swap the active identity by rewriting the jwt file, then reload — no re-login needed

## Capability semantics that dictate test ordering

In `server/services/degraded-operation.ts`:

- `requires` blocks on **`unknown` and `down`**; `requiresNotDown` blocks only on an **open outage**.
- So on a genuinely fresh DB, `flexibility_settlement`/`metered_settlement` refuse immediately
  (meter_telemetry unknown) while `market_bid`/`settlement_payout`/`price_signal_publish`/
  `optimizer_dispatch` refuse only once an outage row is open. Order tests so a real work path opens
  the outage first, otherwise those cards legitimately look "Available".
- `alwaysEnforced` capabilities must refuse even with `DEGRADED_GUARD=observe`.
- Outage opens after **3 consecutive failures**; a partial unique index enforces one open row per
  dependency, so a 4th failure must only increment `failure_count`.

To reset to a genuinely fresh posture, truncate `dependency_observations`, `dependency_outages`,
`degraded_actions`, `settlement_events`, and re-arm fixtures (`flexibility_awards` unsettled,
`control_assignments` with `fallback_claimed_at NULL`, `delivery='accepted'`, `valid_to` in the past).

Useful column names (they are not what you'd guess): `dependency_outages` has
`opened_by`/`closed_by`/`last_detail`/`restored_at` (no `*_observation_id`); `flexibility_awards` has
`settled_at` + `settlement_event_id`.

## Driving real failures and real successes through work paths

- **Failures:** admin `/grid/control-windows` → "Sweep expired now" with `gridd` absent. Each expired
  `ocpp16` assignment makes a real `POST /admin/charging-profile` that fails, recording
  `grid_protocols unreachable` and (since `control_dispatch` is `degradedAllowed`) a `degraded_actions` row.
- **Success that closes the outage:** a genuine signed inbound `POST /api/grid/modbus/readings`.
  HMAC is `sha256(secret)` over `ts` + `"."` + `body`. This also records `meter_telemetry reachable`,
  which unblocks settlement — a clean way to prove a refusal was the guard and not a broken path.
- `degradedOperation.reconcile` expects `{id, note}` — **not** `actionId` (a wrong key yields HTTP 400
  zod errors that look like a product bug). Reconciling twice returns `{"reconciled": false}` and must
  not overwrite the first note.

## Blackholing the platform for the Rust modbus-poller

Do **not** `SIGSTOP` the server: requests merely queue and are processed on resume, producing confusing
duplicate/combined telemetry rows. Instead put a trivial TCP proxy between poller and server
(`poller base_url = http://127.0.0.1:3200` → server `:3000`) and kill the proxy — you get immediate
`Connection refused`, which is a clean outage.

Expect: `publishing readings failed; holding them for the next cycle` with `holding` growing by the
per-cycle reading count, **no** telemetry rows written, and no fabricated zeros. On restore, one cycle
logs `published readings` with `replayed=<backlog>`.

Overflow: rerun with `spool_max_readings = publish_batch_size = 1` against a dead platform and expect
`spool is full: readings discarded, the meter history now has a hole` with `dropped`/`dropped_total`.

**Use a fake meter whose value changes every poll.** A constant-value slave makes replay look lossless
even when most samples are dropped or overwritten. Have `active_power` step (e.g. +100 W per read) and
keep one register constant as a control; then the stored series must be an unbroken arithmetic sequence,
which makes any loss or coalescing immediately visible.

**Watch for instants split across publish batches.** `publish_batch_size` counts *readings*, not
instants, so an odd batch size can put a device's `active_power` in one HTTP request and its
`total_energy` for the *same* `timestamp_ms` in the next. The platform only groups within a request, so
that instant lands as **two half-populated rows** (one with `power` and NULL `energy`, one the reverse)
sharing a device and timestamp. Nothing is lost or fabricated, but assertions of the form "N instants →
N rows" will fail at every batch boundary — check `metadata.registers` and NULL columns before calling
it a coalescing bug. Setting `publish_batch_size` to a multiple of the per-instant register count avoids
it.

## Traps worth knowing (may or may not still be true — verify)

- **Ingest row counts are the thing to check, with varying values.** `POST /api/grid/modbus/readings`
  answers `{"samples": rows written, "readings": registers received}` and stores one row per device per
  *instant*. Always probe with distinct values at distinct `timestamp_ms` — a constant-value fake meter
  hides coalescing completely and makes spool replay look lossless when it is not.
- `settlement.createEvent` is operator-only, credits an explicit `userId` and is capability-guarded.
  Probing it as an ordinary member, or as an operator while `meter_telemetry`/`payment_gateway` is
  unknown, must not append a `settlement_events` row.
- A capability whose dependency is only required to be *not down* reads `Unproven` (amber), not
  `Available`, until something answers a real call. `Available` on a fresh posture page with no
  observations at all is a regression.
- Read DB assertions *after* the mutation settles; a premature query made `settlement_event_id` look
  NULL when it was in fact populated.

## Digital twin and the operations wall (`/digital-twin`, `/grid/operations-wall`)

- The twin is built from **one telemetry row per asset** (`LEFT JOIN LATERAL ... ORDER BY timestamp DESC
  LIMIT 1`), so fixtures are just `assets` + `devices` + `telemetry` rows. Freshness is
  `max(DIGITAL_TWIN_STALENESS_SECONDS (default 300), 3 × device.telemetryInterval)`, so a device with
  `telemetryInterval = 60` still needs a row newer than **300 s** to read as `measured`. Re-stamp
  measured rows immediately before every visual assertion (the page also refetches every 30 s) — an
  hour-old row is unambiguously `stale`.
- Evidence cases worth fixtures: measured non-zero (animates), measured **exactly 0** (idle, `0 W`,
  never "unknown"), stale (last-known value + age, dashed, no motion), never (no row at all,
  `never reported`), a **fresh row with `power IS NULL`** (counts as seen but contributes no number),
  a meter-only scope, and an account with **no assets at all** (empty registry).
- Meters must never enter the behind-meter net: `measuredNetPowerWatts`/`measuredBehindMeter` exclude
  `kind === 'meter'`, and the meter's own reading lives in `meteredGridPowerWatts`. The cheapest
  regression probe is to add a meter row and check the net tile does **not** move.
- Node captions ("empty registry rather than an idle plant", "Only meters are registered here…") are
  rendered as native **SVG `<title>` tooltips**, which do not appear in screenshots and cannot be
  hovered into a screenshot reliably. Assert them from the rendered DOM and say so; the node's colour
  and `never reported`/`stale` label are the parts provable on pixels.
- Breaking one panel or one query is the honest way to test the unavailable surfaces: renaming a column
  (`dependency_observations.observation`) turns exactly one wall panel into the red `PanelUnavailable`,
  and renaming `assets` makes the whole twin render "The twin could not be read, so nothing is drawn."
  Both error surfaces currently print the **raw failing SQL** into the operator UI.
- Do **not** break the DB by terminating backends (`pg_terminate_backend` / restarting postgres) with the
  server up: the pg pool emits an unhandled `error` event and the **node process exits**
  (`node:events:502 throw er; // Unhandled 'error' event ... terminating connection due to administrator
  command`). You then get a proxy error in the browser rather than the product's unavailable state, and
  the server has to be restarted. Rename a table instead. (The crash itself is worth reporting.)
- After a query fails, the twin page keeps the **previous successful** tiles and diagram under the red
  banner (react-query keeps prior data), including a `live · Ns ago` badge. A fresh page load with the
  query already broken is the only way to prove "nothing is drawn".
- Socket.IO: the client connects to `/api/socket.io` and the handshake needs the session cookie
  **`app_session_id=<jwt>`** (not `session=`). Negative tests: no cookie and a bogus cookie both fail
  with `connect_error: Authentication required`; the `join` handler ignores its payload entirely, so a
  forged `join({ userId: <someone else> })` still only returns the handshake user's own telemetry.
- A minted JWT only authenticates if a matching `users` row exists (`"openId"` = the minted `openId`);
  otherwise the app just shows the sign-in screen. Insert the row before blaming the token.
- Migrations `0006`–`0009` add `dependency_observations`, `dependency_outages`, `degraded_actions` and
  `fleet_telemetry_windows`; a DB restored from an older baseline renders three of the four wall panels
  empty until they are applied.

## Mobile (`mobile/`)

`npm install` fails on an `expo`/`@react-native-community/datetimepicker` peer conflict; it succeeds with
`--legacy-peer-deps`. Even then Metro cannot bundle: `package.json` `main` is `expo-router/entry` but
`expo-router` is not a dependency and there is no `app/` dir, and bundling
`node_modules/expo/AppEntry.bundle` fails with `Unable to resolve module expo-auth-session` (imported by
`src/contexts/AuthContext.tsx`, absent from `package.json`). Treat mobile screens as **untested** rather
than faking them. Note `npx expo start` rewrites `mobile/tsconfig.json` — revert it afterwards.

## Money paths (P2P payment reservation and settlement ledger)

- Payment credentials are encrypted with a key derived from `JWT_SECRET`: seed `payment_credentials`
  under the same `JWT_SECRET` the server runs with, or the gateway reads as unconfigured and
  `payForMatch` refuses before writing anything.
- `payForMatch` has no PWA UI — drive it through the tRPC route with a session cookie.
- To force the lost-reservation-race path (insert loses on `23505`, and the winner has already released
  its reservation), run an out-of-band loop that flips the live `pending` reservation for the trade to
  `failed` as fast as possible; the real window is microseconds wide. Expect HTTP 409, never a raw pg
  unique-violation 500. Sequential retries instead return the same `paymentId`.
- `settlement-ledger.createEvent` publishes to Kafka synchronously, so with no broker each event spends
  ~30s in KafkaJS retries — budget for it on ledger-heavy paths.
- `settlement_events` columns are snake_case while `payments`/`trades` are camelCase.
- Migrations `0010`-`0012` need a fresh database; the long-lived local `vpp` DB has enum drift.
- A stale PWA service worker serves old chunks, so a newly added component can look broken when it is
  not: unregister the SW and clear `caches.keys()` before concluding anything about the UI.

## ML training stack (`services/ml`, `vppml` CLI, `/admin/model-health`)

- Runtime needs **`ML_DATABASE_URL`** (or `DATABASE_URL`) **and `ML_ARTIFACT_DIR`**, or the CLI refuses at
  config load. Use the venv at `services/ml/.venv`; a synthetic train is ~30 s at 6 epochs.
- `ray[client]` is **not** installed in that venv, so a `ray://` address refuses on the missing extra
  rather than on connectivity. The honesty property (exit 3, no `training_runs` row, no new registry
  version, no local fallback) is still provable, but a cluster-reachability refusal needs
  `./.venv/bin/pip install 'ray[client]'` before it can be claimed.
- Column names differ from the TypeScript side: `training_runs` uses **`state`/`refusal_reason`** (not
  `status`/`error_message`), and `model_registry.metrics` is **text**, so nested reads need `::jsonb`.
- Feature drift only becomes `measured` with **≥200 observations** from `telemetry`/`assets`, and the
  synthetic origin writes **no platform tables** — platform-origin training and any drift case therefore
  need seeded telemetry first. Auto-queued `performance_threshold` jobs default to `origin=platform`, so
  without telemetry they correctly refuse with "0 row(s) produced no usable 24+4 step window".
- Measured degradation needs at least one prediction with a non-NULL `actual_value` at ≥1.5× the
  recorded `val_mae_w`; below `MIN_SCORED_PREDICTIONS` (20) the page says the sample is too small rather
  than reporting a live MAE.
- Verification is provable on pixels: tamper a checkpoint's bytes → `weights altered`, delete it →
  `weights gone`, and a registry row with no run/artifact → `no artifact`. Cross-check `sha256sum` on
  disk against `model_registry.artifact_hash` and `training_runs.checkpoint_digest`.
- tRPC mutations (e.g. `mlops.triggerRetraining`) must be sent with the **`{"json":{...}}` envelope**;
  refusals are recorded as `cancelled` with the reason, never `completed`.

## Devin Secrets Needed

None for this layer; all dependencies are deliberately absent locally. Real MQTT, Redis, `gridd`,
MILP optimizer, market broker, payment sandboxes, Matter controller, Temporal and Modbus hardware
remain out of reach and must be reported as gaps, never simulated.

## Browser harness (route sweeps, role guards)

- The server rate-limits globally at **300 requests / 15 min per IP** (`server/_core/index.ts`), and every
  page load fires many `/api/trpc/*` calls, so sweeping tens of routes exhausts it. The symptom is not an
  obvious rate-limit error: `auth.me` returns 429 and every page renders "Please sign in to continue",
  which reads as a broken auth guard. Check `ratelimit-remaining`/`retry-after`, sweep in small batches,
  and restart the server to reset the in-memory counter.
- `pkill -f 'tsx watch server/_core'` does not reliably kill the server; find the real owner with
  `ss -ltnp` / `fuser -n tcp 3000` and kill the child node PID. `npm run dev` is the only reliable start
  (invoking the tsx CLI through `node` fails with a SyntaxError).
- Assert route chrome and navigation state on the DOM contract, not on text: `[data-sidebar="sidebar"]`
  count (exactly 1, or 0 on the full-viewport operations wall), `input[aria-label="Find a page"]`,
  `[data-active="true"]` for the active nav item, and `button[data-state="open"]` for its group.
- Role guards must be checked twice: by direct URL in the browser **and** by calling the tRPC HTTP route
  with the member session cookie, since the client redirect and the server procedure are separate gates.
