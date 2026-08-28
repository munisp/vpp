/**
 * P0-4 isolated grid safety integration test.
 *
 * Run only through docker-compose.grid-e2e.yml. The suite intentionally uses:
 *   - a disposable PostgreSQL database (migrated and whole-schema seeded),
 *   - the public controlWindows tRPC router with administrator middleware,
 *   - the real TypeScript grid command client,
 *   - the real Go grid-protocols HTTP admin API, and
 *   - an OCPP 1.6J simulator connected to that daemon by WebSocket.
 *
 * It does not mock setChargingProfile, clearChargingProfile, the protocol
 * daemon, or the OCPP response. The synthetic charge point is integration
 * evidence only; it does not replace the required certified non-production
 * device exercise before a production grid-control release.
 */

import type { User } from '../drizzle/schema';
import { controlWindowsRouter } from './routers/controlWindows';
import { connectedChargePoints } from './services/grid-commands';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';

const { Client } = pg;
const ENABLED = process.env.GRID_E2E_ENABLED === 'true';
const describeGrid = ENABLED ? describe : describe.skip;
const CHARGE_POINT = 'CP-E2E-1';
const CONNECTOR = 1;
const simulatorUrl = process.env.GRID_E2E_SIMULATOR_URL;
const databaseUrl = process.env.DATABASE_URL;

interface SimulatorEvent {
  at: string;
  type: string;
  action?: string;
  unique_id?: string;
  status?: string;
  profile_id?: number;
  valid_from?: string;
  valid_to?: string;
  detail?: string;
}

interface AssignmentRow {
  id: number;
  delivery: 'accepted' | 'rejected' | 'unconfirmed';
  command_ref: string | null;
  valid_from: Date;
  valid_to: Date;
  fallback_policy: string;
  fallback_outcome: string | null;
  fallback_detail: string | null;
}

let client: pg.Client;
let adminUser: User;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required to run the isolated grid E2E suite`);
  return value;
}

function contextFor(user: User | null) {
  return {
    user,
    // The caller is intentionally created through the public tRPC router. The
    // request/response objects are unused by these procedures, and a persisted
    // test user supplies the authorization identity.
    req: {} as never,
    res: {} as never,
  };
}

function adminCaller() {
  return controlWindowsRouter.createCaller(contextFor(adminUser));
}

function nonAdminCaller() {
  return controlWindowsRouter.createCaller(contextFor({ ...adminUser, role: 'user' }));
}

async function simulator(method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${required(simulatorUrl, 'GRID_E2E_SIMULATOR_URL')}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`simulator ${method} ${path} returned HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function events(): Promise<SimulatorEvent[]> {
  return (await simulator('GET', '/events')).events as SimulatorEvent[];
}

async function waitFor<T>(
  description: string,
  predicate: () => Promise<T | undefined>,
  timeoutMs = 12_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ''}`
  );
}

async function waitForConnection(connected: boolean): Promise<void> {
  await waitFor(`simulator connection=${connected}`, async () => {
    const health = await simulator('GET', '/health') as { connected: boolean };
    if (health.connected !== connected) return undefined;
    const chargePoints = await connectedChargePoints();
    return chargePoints.includes(CHARGE_POINT) === connected ? true : undefined;
  });
}

async function commandEvent(action: string, profileId?: number, status?: string): Promise<SimulatorEvent> {
  return waitFor(`OCPP ${action} command`, async () => {
    const matched = (await events()).find(event =>
      event.type === 'command' &&
      event.action === action &&
      (profileId === undefined || event.profile_id === profileId)
    );
    if (!matched) return undefined;
    if (status !== undefined) {
      const result = (await events()).find(event =>
        event.type === 'response' && event.unique_id === matched.unique_id && event.status === status
      );
      if (!result) return undefined;
    }
    return matched;
  });
}

async function assignment(assignmentId: number): Promise<AssignmentRow> {
  const result = await client.query<AssignmentRow>(
    `SELECT id, delivery, command_ref, valid_from, valid_to, fallback_policy, fallback_outcome, fallback_detail
       FROM control_assignments
      WHERE id = $1`,
    [assignmentId]
  );
  if (!result.rows[0]) throw new Error(`control assignment ${assignmentId} was not persisted`);
  return result.rows[0];
}

async function fallbackEventCount(assignmentId: number): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM control_fallback_events WHERE assignment_id = $1',
    [assignmentId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

function dispatchInput(profileId: number, fallbackPolicy: 'safe_limit' | 'resume_local' = 'safe_limit') {
  return {
    chargePointId: CHARGE_POINT,
    connectorId: CONNECTOR,
    chargingProfileId: profileId,
    periods: [{ startPeriodSeconds: 0, limitWatts: 3_600 }],
    validForSeconds: 60,
    fallbackPolicy,
    ...(fallbackPolicy === 'safe_limit' ? { fallbackLimitWatts: 1_400 } : {}),
  };
}

describeGrid('P0-4 grid dispatch through real OCPP simulator', () => {
  beforeAll(async () => {
    required(databaseUrl, 'DATABASE_URL');
    required(simulatorUrl, 'GRID_E2E_SIMULATOR_URL');
    required(process.env.GRID_PROTOCOL_SERVICE_URL, 'GRID_PROTOCOL_SERVICE_URL');
    required(process.env.GRID_PROTOCOL_SHARED_SECRET, 'GRID_PROTOCOL_SHARED_SECRET');

    client = new Client({ connectionString: databaseUrl });
    await client.connect();

    // The all-table seed provides a valid user. Promote it only inside this
    // disposable database so the public adminProcedure is exercised with a
    // persisted administrator rather than an invented identity.
    const seeded = await client.query<User>(
      `UPDATE users
          SET role = 'admin'
        WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)
      RETURNING *`
    );
    if (!seeded.rows[0]) throw new Error('whole-schema seed did not provide a user for grid E2E');
    adminUser = seeded.rows[0];

    await waitForConnection(true);
  });

  beforeEach(async () => {
    await simulator('POST', '/reset');
    await waitForConnection(true);
    // These tables are part of the disposable grid E2E database. Deleting only
    // CP-E2E-1 rows lets each scenario prove its own persisted outcome.
    await client.query('DELETE FROM control_assignments WHERE target_ref = $1', [CHARGE_POINT]);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('refuses a non-administrator before any OCPP command is sent', async () => {
    const before = (await events()).filter(event => event.type === 'command').length;
    await expect(nonAdminCaller().dispatchChargingPlan(dispatchInput(9101))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const after = (await events()).filter(event => event.type === 'command').length;
    expect(after).toBe(before);
  });

  it('records an accepted bounded command and the matching OCPP receipt', async () => {
    const result = await adminCaller().dispatchChargingPlan(dispatchInput(9102));
    expect(result).toMatchObject({ delivered: true, status: 'Accepted' });
    expect(result.assignmentId).toEqual(expect.any(Number));

    const receipt = await commandEvent('SetChargingProfile', 9102, 'Accepted');
    expect(receipt.valid_from).toBeTruthy();
    expect(receipt.valid_to).toBeTruthy();

    const persisted = await assignment(result.assignmentId!);
    expect(persisted.delivery).toBe('accepted');
    expect(persisted.command_ref).toBe('9102');
    expect(persisted.fallback_policy).toBe('safe_limit');
    expect(persisted.valid_to.toISOString()).toBe(receipt.valid_to);
  });

  it('records an explicit device rejection without falsely reporting delivery', async () => {
    await simulator('POST', '/mode', { mode: 'reject' });
    const result = await adminCaller().dispatchChargingPlan(dispatchInput(9103));
    expect(result).toMatchObject({ delivered: false, status: 'rejected' });
    expect(result.assignmentId).toEqual(expect.any(Number));

    await commandEvent('SetChargingProfile', 9103, 'Rejected');
    expect((await assignment(result.assignmentId!)).delivery).toBe('rejected');
  });

  it('records a real OCPP call timeout as unconfirmed rather than accepted', async () => {
    await simulator('POST', '/mode', { mode: 'timeout' });
    const result = await adminCaller().dispatchChargingPlan(dispatchInput(9104));
    expect(result).toMatchObject({ delivered: false, status: 'unconfirmed' });
    expect(result.reason).toMatch(/did not answer|unreachable|delivery is unconfirmed/i);

    await commandEvent('SetChargingProfile', 9104);
    const persisted = await assignment(result.assignmentId!);
    expect(persisted.delivery).toBe('unconfirmed');
  }, 12_000);

  it('preserves unknown delivery while offline, reconnects, and accepts a fresh bounded command', async () => {
    await simulator('POST', '/disconnect');
    await waitForConnection(false);

    const offline = await adminCaller().dispatchChargingPlan(dispatchInput(9105));
    expect(offline).toMatchObject({ delivered: false, status: 'unconfirmed' });
    expect((await assignment(offline.assignmentId!)).delivery).toBe('unconfirmed');

    await simulator('POST', '/connect');
    await waitForConnection(true);
    const retried = await adminCaller().dispatchChargingPlan(dispatchInput(9106));
    expect(retried).toMatchObject({ delivered: true, status: 'Accepted' });
    await commandEvent('SetChargingProfile', 9106, 'Accepted');
    expect((await assignment(retried.assignmentId!)).delivery).toBe('accepted');
  }, 20_000);

  it('proves local profile expiry and sends the safe-limit fallback with matching persisted evidence', async () => {
    const caller = adminCaller();
    const standing = await caller.installFallbackProfile({
      chargePointId: CHARGE_POINT,
      connectorId: CONNECTOR,
      chargingProfileId: 1,
      limitWatts: 1_400,
    });
    expect(standing).toMatchObject({ status: 'Accepted', limitWatts: 1_400 });
    await commandEvent('SetChargingProfile', 1, 'Accepted');

    const dispatched = await caller.dispatchChargingPlan(dispatchInput(9107));
    expect(dispatched).toMatchObject({ delivered: true, status: 'Accepted' });
    await commandEvent('SetChargingProfile', 9107, 'Accepted');

    // A one-minute window is the production minimum. The simulator independently
    // removes the bounded profile when validTo passes, proving it does not depend
    // on the TypeScript sweeper remaining alive.
    await waitFor('simulator local validTo expiry', async () => {
      return (await events()).find(event =>
        event.type === 'local_profile_expired' && event.profile_id === 9107
      );
    }, 70_000);

    const fallbackBefore = (await events()).filter(event =>
      event.type === 'command' && event.action === 'SetChargingProfile' && event.profile_id === 1
    ).length;
    const swept = await caller.sweepNow();
    expect(swept.applied).toBeGreaterThanOrEqual(1);
    await waitFor('a new safe-limit OCPP fallback receipt', async () => {
      const matching = (await events()).filter(event =>
        event.type === 'command' && event.action === 'SetChargingProfile' && event.profile_id === 1
      );
      return matching.length > fallbackBefore ? matching[matching.length - 1] : undefined;
    });

    const persisted = await assignment(dispatched.assignmentId!);
    expect(persisted.fallback_outcome).toBe('applied');
    expect(persisted.fallback_detail).toMatch(/safe_limit: 1400W/i);
    expect(await fallbackEventCount(dispatched.assignmentId!)).toBe(1);
  }, 80_000);

  it('uses a real ClearChargingProfile receipt for an expired resume_local assignment', async () => {
    const dispatched = await adminCaller().dispatchChargingPlan(dispatchInput(9108, 'resume_local'));
    expect(dispatched).toMatchObject({ delivered: true, status: 'Accepted' });
    await commandEvent('SetChargingProfile', 9108, 'Accepted');

    // The public route recorded a valid 60-second window. Make it eligible for a
    // deterministic sweeper test in the disposable database, then invoke the
    // public sweep route; no command transport is mocked.
    await client.query(
      `UPDATE control_assignments
          SET valid_from = NOW() - interval '61 seconds',
              valid_to = NOW() - interval '1 second'
        WHERE id = $1`,
      [dispatched.assignmentId]
    );
    const swept = await adminCaller().sweepNow();
    expect(swept.applied).toBeGreaterThanOrEqual(1);
    await commandEvent('ClearChargingProfile', undefined, 'Accepted');

    const persisted = await assignment(dispatched.assignmentId!);
    expect(persisted.fallback_outcome).toBe('applied');
    expect(persisted.fallback_detail).toMatch(/resume_local: ClearChargingProfile answered Accepted/);
    expect(await fallbackEventCount(dispatched.assignmentId!)).toBe(1);
  });

  it.todo(
    'proves administrator-authorized emergency-stop delivery with a real edge gateway receipt and device telemetry; the current platform has no deployed edge-gateway transport endpoint to test'
  );
});
