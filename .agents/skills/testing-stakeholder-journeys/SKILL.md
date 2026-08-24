---
name: testing-stakeholder-journeys
description: How to bring up and end-to-end test the stakeholder-journeys assurance layer (shared/journeys.ts catalog, server/journeys engine, journeys tRPC router, Temporal journey worker on queue stakeholder-journeys, PWA /admin/journeys, mobile Journeys screen), including adversarial worker-kill, rerun-safety, four-valued outcome reconciliation against Postgres, and the model-health train/promote/rollback cycle.
---

# Testing the stakeholder journeys assurance layer

## Services needed

All of these must be up before the app; the journeys deliberately touch every dependency so
that missing ones surface as `blocked` rather than `passed`:

| dependency | endpoint | notes |
|---|---|---|
| Postgres | `postgres://vpp:vpp@127.0.0.1:5432/vpp_journeys` | dedicated DB is convenient; `npm run db:push` to create schema |
| Temporal dev server | `127.0.0.1:7233` (ns `default`) | CLI is at `/home/ubuntu/bin/temporal`, **not** on PATH |
| optimizer | `http://127.0.0.1:8099` | run from `services/optimizer/.venv`; env var is `OPTIMIZER_SERVICE_URL` (not `OPTIMIZER_URL`) and `OPTIMIZER_AUTH_TOKEN` must match the process |
| TigerBeetle | `127.0.0.1:3033` | finance-daily-close journey |
| mosquitto | `mqtt://127.0.0.1:1883` | grid dispatch / price signal journeys |
| MinIO | `http://127.0.0.1:9000`, bucket `vpp-lake` | `LAKEHOUSE_STORE=s3` |
| Ollama | `http://127.0.0.1:11434`, `qwen2.5:1.5b` | support-diagnosis journey |

Env recipe (see e.g. `/home/ubuntu/pr59/env.sh`): `DATABASE_URL`, `JWT_SECRET`, `VITE_APP_ID`,
`TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE`, `MQTT_BROKER_URL`, `OPTIMIZER_SERVICE_URL`+`OPTIMIZER_AUTH_TOKEN`,
`TIGERBEETLE_ADDRESSES`+`TIGERBEETLE_CLUSTER_ID`, `LAKEHOUSE_*`/`S3_*`, `OLLAMA_URL`+`OLLAMA_MODEL`,
`ML_ARTIFACT_DIR`.

Start the app (`npm run dev`) and the worker (`npx tsx server/workflows/journey-worker.ts`) with the
same env. The worker logs `[Journey Worker] Listening on stakeholder-journeys at …` when ready.

Trap: `pkill -f journey-worker.ts` matches the pkill command itself and kills the caller —
find the PID with `ps` and `kill <pid>`.

## Auth for the browser

Mobile/PWA tRPC auth is the `app_session_id` **cookie**, which the browser console cannot set for the
dev origin reliably. Run a tiny proxy (e.g. `/home/ubuntu/pr59/proxy.mjs` on `:3100`) that injects
`Cookie: app_session_id=$(cat current.jwt)` and point the browser at the proxy. Mint HS256 JWTs with
`{openId, appId, name}` against `JWT_SECRET`; swap the file to change identity (admin vs member) and
reload. Verify with `auth.me`.

## What to assert

- **Catalog + coverage**: `/admin/journeys` shows 20 journeys, tiles (exercisable score, journeys
  passed, blocked-on-external, never-run) and a coverage panel. Coverage is computed from each app's
  own navigation, so a new route/screen without a journey shows as uncovered — a good regression trap.
- **Four-valued outcomes**: `passed / refused / blocked / failed`. Blocked and not-run must be
  excluded from the score, never rendered as a pass. With no gateway/SMS credentials expect
  `billing-to-payment › pay-invoice`, `prepaid-energy-purchase › initiate-topup`,
  `p2p-neighbour-trade › pay-for-match`, `community-and-rewards › sms-channel` **blocked**.
- **UI ↔ DB reconciliation** (the highest-value check). Both columns are Postgres enums, so cast:

```sql
select r.run_key, r.state::text, count(*) filter (where p.outcome::text='failed') failed,
       count(*) filter (where p.outcome::text='blocked') blocked
from journey_runs r join journey_step_results p on p.run_id=r.id
where r.run_key like '<suite label>%' group by 1,2;
```

  Invariants: a `failed` run must have ≥1 `failed` step row; a run with no failed but ≥1 blocked step
  must be `blocked`. A "failed run with all-passed steps" is the classic symptom of a step being
  retried by Temporal and overwriting its own step row (see timing below).

- **Timing contract**: journey steps run as single Temporal activities with
  `STEP_ACTIVITY_TIMEOUT_MS` (`server/workflows/journey-workflow.ts`). Any step that sleeps
  (the flexibility `clear-and-measure` waits out its delivery window, `DELIVERY_WINDOW_LEAD_MS` +
  window in `server/journeys/steps/grid.ts`) must fit inside that timeout, or it times out and
  re-runs its side effects. When testing a timing change, check the history explicitly:

```bash
/home/ubuntu/bin/temporal workflow show --address 127.0.0.1:7233 \
  --workflow-id "journey-<journeyId>:<label>" -o json > hist.json
grep -c ACTIVITY_TASK_TIMED_OUT hist.json
python3 -c "import json;d=json.load(open('hist.json'));
print([(e['activityTaskScheduledEventAttributes']['activityType']['name'],
        e.get('activityTaskStartedEventAttributes',{}).get('attempt'))
       for e in d['events'] if 'activityTaskStartedEventAttributes' in e])"
```

- **Adversary — kill the worker mid-step**: dispatch a single journey
  (`POST /api/trpc/journeys.start` with body `{"json":{"journeyId":"…","label":"…","memberUserId":2}}`
  — note the `json` envelope and that the field is `label`, not `runKey`), wait until the sleeping step
  starts, `kill` the worker PID, then restart it on the same queue. Temporal re-delivers the activity
  (attempt 2) and the run should still settle honestly. Money-duplication check:

```sql
select requirement_id, count(*) awards, count(distinct settlement_event_id) settlements
from flexibility_awards group by 1 order by 1 desc;
select source_id, count(*) from settlement_events where source_type='flexibility_award' group by 1;
```

- **Rerun safety**: same label re-dispatches the same workflow id with a new run id and should update
  the single `journey_runs` row (no duplicate `run_key`); a new label on the same data must not fail on
  once-issued device credentials or on "already cleared/settled" refusals.

- **Money honesty**: read `flexibility_awards.delivered_energy_wh` / `price_cents_per_kwh` against
  `settlement_events.rate_per_unit/gross_amount/net_amount`. Watch for small measured energies rounding
  to a zero credit while the UI still says "settled … paid into ledger" — `PRICE_SCALE` division plus
  `Math.round` in `server/services/locational-flexibility.ts` can silently produce a 0-value settlement.

- **Authorization**: `journeys.catalog` and `journeys.coverage` are `protectedProcedure` (any signed-in
  user, static data only); `start`, `startSuite`, `run`, `runs`, `report` are `adminProcedure` and must
  return `FORBIDDEN` for a member. A member loading `/admin/journeys` should be redirected away with no
  run data. `modelHealth.overview` is admin-only too.

- **Model health**: with the ML venv (`services/ml/.venv`) and `ML_ARTIFACT_DIR`,
  `python -m vppml.cli train --origin synthetic --seed N`, `promote --model … --version vN`,
  `rollback --model … --to v1`. The registry table is `model_registry` with columns
  `model_version`, `status`, `artifact_hash`, `rolled_back_from_id` (NOT `ml_model_versions`/`version`).
  Assert exactly one `production` row at each stage, `production · rolled back from vN` provenance after
  rollback, `artifact_hash` == `sha256sum` of the file, and that appending bytes to the artifact flips the
  page to `weights altered` / `0/1 verified` with a serving-unsafe note (restore the file afterwards).

## Devin Secrets Needed

None for the above. Payment-gateway and SMS credentials (M-Pesa / Airtel / Tigo, SMS provider) and
`QR_SIGNING_SECRET` are intentionally absent in test environments — the correct expectation is
`blocked`/`refused`, never a simulated provider and never a pass.
