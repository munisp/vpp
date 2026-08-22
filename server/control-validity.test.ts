/**
 * Regression tests for control validity windows and degraded-mode fallback:
 *  - no control may be unbounded, inverted, already expired, too short or longer
 *    than the deployment cap
 *  - a schedule may not outlive the window that authorises it
 *  - a safe_limit fallback has no guessed default watts
 *  - a fallback is only recorded as applied when the device took it; offline,
 *    refused and unconfirmed deliveries stay distinguishable
 *  - hold_last is recorded as a setpoint still live on the hardware, not as a
 *    successful safe fallback
 *  - two sweepers cannot both deliver the same fallback
 *  - clearing a profile without a selector is refused
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ControlAssignment } from '../drizzle/control-schema';

const ORIGINAL_ENV = { ...process.env };
const NOW = new Date('2026-03-01T12:00:00.000Z');

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./services/grid-commands');
  vi.doUnmock('./services/control-validity');
});

function at(offsetSeconds: number): Date {
  return new Date(NOW.getTime() + offsetSeconds * 1000);
}

describe('resolveControlWindow', () => {
  it('refuses a control with no expiry', async () => {
    const { resolveControlWindow } = await import('./services/control-validity');
    expect(() => resolveControlWindow({}, NOW)).toThrow(/explicit validTo/);
  });

  it('refuses a window that already ended', async () => {
    const { resolveControlWindow } = await import('./services/control-validity');
    expect(() =>
      resolveControlWindow({ validFrom: at(-7200), validTo: at(-3600) }, NOW)
    ).toThrow(/before it was issued/);
  });

  it('refuses an inverted window', async () => {
    const { resolveControlWindow } = await import('./services/control-validity');
    expect(() => resolveControlWindow({ validFrom: at(600), validTo: at(300) }, NOW)).toThrow(
      /minimum is/
    );
  });

  it('refuses a window shorter than one refresh cycle', async () => {
    const { resolveControlWindow, MIN_VALIDITY_SECONDS } = await import(
      './services/control-validity'
    );
    expect(() => resolveControlWindow({ validForSeconds: 30 }, NOW)).toThrow(
      new RegExp(`minimum is ${MIN_VALIDITY_SECONDS}s`)
    );
  });

  it('refuses a window longer than the configured cap', async () => {
    process.env.GRID_CONTROL_MAX_VALIDITY_SECONDS = '900';
    const { resolveControlWindow } = await import('./services/control-validity');
    expect(() => resolveControlWindow({ validForSeconds: 1800 }, NOW)).toThrow(/caps it at 900s/);
  });

  it('rejects a cap below the minimum window rather than using it', async () => {
    process.env.GRID_CONTROL_MAX_VALIDITY_SECONDS = '10';
    const { resolveControlWindow } = await import('./services/control-validity');
    expect(() => resolveControlWindow({ validForSeconds: 600 }, NOW)).toThrow(
      /GRID_CONTROL_MAX_VALIDITY_SECONDS/
    );
  });

  it('normalises a duration into an explicit window', async () => {
    const { resolveControlWindow } = await import('./services/control-validity');
    const window = resolveControlWindow({ validForSeconds: 900 }, NOW);
    expect(window.validFrom.toISOString()).toBe(NOW.toISOString());
    expect(window.validTo.toISOString()).toBe(at(900).toISOString());
    expect(window.seconds).toBe(900);
  });
});

describe('resolveFallbackLimit', () => {
  beforeEach(() => {
    delete process.env.GRID_CONTROL_FALLBACK_LIMIT_W;
  });

  it('refuses safe_limit with no configured watts instead of guessing', async () => {
    const { resolveFallbackLimit } = await import('./services/control-validity');
    expect(() => resolveFallbackLimit('safe_limit')).toThrow(/GRID_CONTROL_FALLBACK_LIMIT_W/);
  });

  it('refuses a non-finite explicit limit', async () => {
    const { resolveFallbackLimit } = await import('./services/control-validity');
    expect(() => resolveFallbackLimit('safe_limit', Number.NaN)).toThrow(/finite/);
  });

  it('needs no watts for the policies that send no setpoint', async () => {
    const { resolveFallbackLimit } = await import('./services/control-validity');
    expect(resolveFallbackLimit('resume_local')).toBeNull();
    expect(resolveFallbackLimit('hold_last')).toBeNull();
  });
});

describe('assignmentState', () => {
  const base = {
    validFrom: at(-600),
    validTo: at(600),
    delivery: 'accepted' as const,
    supersededAt: null,
    fallbackAppliedAt: null,
    fallbackOutcome: null,
    fallbackPolicy: 'safe_limit' as const,
  };

  it('reports an expired window as awaiting its fallback', async () => {
    const { assignmentState } = await import('./services/control-validity');
    expect(assignmentState({ ...base, validTo: at(-1) }, NOW)).toBe('expired_awaiting_fallback');
  });

  it('does not report an offline fallback as applied', async () => {
    const { assignmentState } = await import('./services/control-validity');
    expect(
      assignmentState(
        {
          ...base,
          validTo: at(-1),
          fallbackAppliedAt: NOW,
          fallbackOutcome: 'device_offline',
        },
        NOW
      )
    ).toBe('fallback_failed');
  });

  it('does not report an unconfirmed fallback as applied', async () => {
    const { assignmentState } = await import('./services/control-validity');
    expect(
      assignmentState(
        { ...base, validTo: at(-1), fallbackAppliedAt: NOW, fallbackOutcome: 'unconfirmed' },
        NOW
      )
    ).toBe('fallback_failed');
  });

  it('marks hold_last as a setpoint still live past its window', async () => {
    const { assignmentState } = await import('./services/control-validity');
    expect(
      assignmentState(
        {
          ...base,
          fallbackPolicy: 'hold_last',
          validTo: at(-1),
          fallbackAppliedAt: NOW,
          fallbackOutcome: 'not_required',
        },
        NOW
      )
    ).toBe('held_past_window');
  });

  it('warns before the window closes', async () => {
    const { assignmentState, EXPIRING_WINDOW_SECONDS } = await import(
      './services/control-validity'
    );
    expect(assignmentState({ ...base, validTo: at(EXPIRING_WINDOW_SECONDS - 1) }, NOW)).toBe(
      'expiring'
    );
    expect(assignmentState({ ...base, validTo: at(EXPIRING_WINDOW_SECONDS + 60) }, NOW)).toBe(
      'active'
    );
  });
});

describe('recordControlAssignment', () => {
  /**
   * Captures whether the insert retired the target's previous accepted control.
   * A refused replacement must leave the predecessor live, or the setpoint the
   * device is still executing drops out of the expiry sweep and never gets its
   * fallback.
   */
  async function insertHarness() {
    const state = { supersedes: 0 };
    const tx = {
      update: () => ({
        set: () => ({
          where: async () => {
            state.supersedes += 1;
          },
        }),
      }),
      insert: () => ({
        values: () => ({ returning: async () => [{ id: 99 }] }),
      }),
    };
    vi.doMock('./db', () => ({
      getDb: vi.fn(async () => ({
        transaction: async (cb: (t: typeof tx) => Promise<number | null>) => cb(tx),
      })),
    }));
    return state;
  }

  const assignment = {
    protocol: 'ocpp16' as const,
    targetRef: 'CP-1',
    subTargetRef: 1,
    source: 'v2g_schedule' as const,
    window: { validFrom: NOW, validTo: at(900), seconds: 900 },
    fallbackPolicy: 'safe_limit' as const,
    fallbackLimitWatts: 1400,
  };

  afterEach(() => {
    vi.doUnmock('./db');
  });

  it('retires the previous control only when the replacement was accepted', async () => {
    const state = await insertHarness();
    const { recordControlAssignment } = await import('./services/control-validity');
    await expect(
      recordControlAssignment({ ...assignment, delivery: 'accepted' })
    ).resolves.toBe(99);
    expect(state.supersedes).toBe(1);
  });

  it('leaves the live control in place when the charge point refused the replacement', async () => {
    const state = await insertHarness();
    const { recordControlAssignment } = await import('./services/control-validity');
    await recordControlAssignment({ ...assignment, delivery: 'rejected' });
    await recordControlAssignment({ ...assignment, delivery: 'unconfirmed' });
    expect(state.supersedes).toBe(0);
  });
});

describe('setChargingProfile', () => {
  beforeEach(() => {
    process.env.GRID_PROTOCOL_SERVICE_URL = 'http://127.0.0.1:9999';
    process.env.GRID_PROTOCOL_SHARED_SECRET = 'k'.repeat(32);
  });

  it('refuses a schedule that outlives its validity window', async () => {
    const { setChargingProfile } = await import('./services/grid-commands');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(
      setChargingProfile({
        chargePointId: 'CP-1',
        connectorId: 1,
        chargingProfileId: 7,
        purpose: 'TxDefaultProfile',
        stackLevel: 1,
        periods: [{ startPeriodSeconds: 0, limitWatts: 3600 }],
        durationSeconds: 3600,
        validTo: new Date(Date.now() + 600_000),
      })
    ).rejects.toThrow(/validity window is 600s/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the window to the charge point so it expires on its own clock', async () => {
    const { setChargingProfile } = await import('./services/grid-commands');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'Accepted' }), { status: 200 })
    );
    const validTo = new Date(Date.now() + 900_000);
    const result = await setChargingProfile({
      chargePointId: 'CP-1',
      connectorId: 1,
      chargingProfileId: 7,
      purpose: 'TxDefaultProfile',
      stackLevel: 1,
      periods: [{ startPeriodSeconds: 0, limitWatts: 3600 }],
      validTo,
    });
    expect(result.status).toBe('Accepted');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.request.csChargingProfiles.validTo).toBe(validTo.toISOString());
    expect(body.request.csChargingProfiles.validFrom).toBeTruthy();
  });
});

describe('clearChargingProfile', () => {
  beforeEach(() => {
    process.env.GRID_PROTOCOL_SERVICE_URL = 'http://127.0.0.1:9999';
    process.env.GRID_PROTOCOL_SHARED_SECRET = 'k'.repeat(32);
  });

  it('refuses a selector-less request that would clear every profile', async () => {
    const { clearChargingProfile } = await import('./services/grid-commands');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(clearChargingProfile({ chargePointId: 'CP-1' })).rejects.toThrow(
      /at least one selector/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** An accepted, expired assignment as the sweeper would read it. */
function expiredRow(overrides: Partial<ControlAssignment> = {}): ControlAssignment {
  return {
    id: 1,
    protocol: 'ocpp16',
    targetRef: 'CP-1',
    subTargetRef: 1,
    commandRef: '7',
    assetId: null,
    evId: null,
    userId: null,
    source: 'optimizer',
    sourceId: null,
    setpointWatts: 3600,
    validFrom: at(-1200),
    validTo: at(-60),
    fallbackPolicy: 'safe_limit',
    fallbackLimitWatts: 1400,
    delivery: 'accepted',
    deliveryDetail: null,
    supersededAt: null,
    fallbackClaimedAt: null,
    fallbackAppliedAt: null,
    fallbackOutcome: null,
    fallbackDetail: null,
    createdAt: at(-1200),
    updatedAt: at(-1200),
    ...overrides,
  } as ControlAssignment;
}

interface SweepHarness {
  rows: ControlAssignment[];
  claims: number[];
  claimResult: boolean;
  outcomes: Array<{ id: number; outcome: string; detail: string }>;
  held: number[];
  fallbackCalls: unknown[];
  clearCalls: unknown[];
  fallbackError?: Error;
  clearError?: Error;
}

/**
 * Mocks the persistence and protocol boundaries so the sweep's decisions are
 * observable: which device commands were sent and what outcome was recorded.
 */
async function harness(state: Partial<SweepHarness> = {}) {
  const h: SweepHarness = {
    rows: [],
    claims: [],
    claimResult: true,
    outcomes: [],
    held: [],
    fallbackCalls: [],
    clearCalls: [],
    ...state,
  };

  const actualCommands = await import('./services/grid-commands');
  vi.doMock('./services/grid-commands', () => ({
    ...actualCommands,
    setFallbackProfile: vi.fn(async (input: unknown) => {
      h.fallbackCalls.push(input);
      if (h.fallbackError) throw h.fallbackError;
      return { status: 'Accepted' };
    }),
    clearChargingProfile: vi.fn(async (input: unknown) => {
      h.clearCalls.push(input);
      if (h.clearError) throw h.clearError;
      return { status: 'Accepted' };
    }),
  }));

  const actualValidity = await import('./services/control-validity');
  vi.doMock('./services/control-validity', () => ({
    ...actualValidity,
    expiredAssignments: vi.fn(async () => h.rows),
    claimForFallback: vi.fn(async (id: number) => {
      h.claims.push(id);
      return h.claimResult;
    }),
    releaseFallbackClaim: vi.fn(async () => undefined),
    recordFallbackOutcome: vi.fn(async (id: number, _reason: string, outcome: string, detail: string) => {
      h.outcomes.push({ id, outcome, detail });
    }),
    closeHoldLast: vi.fn(async (assignment: ControlAssignment) => {
      h.held.push(assignment.id);
    }),
  }));

  return h;
}

describe('sweepExpiredControls', () => {
  beforeEach(() => {
    process.env.GRID_PROTOCOL_SERVICE_URL = 'http://127.0.0.1:9999';
    process.env.GRID_PROTOCOL_SHARED_SECRET = 'k'.repeat(32);
    process.env.GRID_CONTROL_FALLBACK_LIMIT_W = '1400';
  });

  it('applies the safe limit when a window closes', async () => {
    const h = await harness({ rows: [expiredRow()] });
    const { sweepExpiredControls } = await import('./services/control-delivery');
    const result = await sweepExpiredControls(NOW);
    expect(result.applied).toBe(1);
    expect(h.fallbackCalls).toHaveLength(1);
    expect(h.outcomes[0]?.outcome).toBe('applied');
  });

  it('revokes our profile for resume_local instead of sending a setpoint', async () => {
    const h = await harness({
      rows: [expiredRow({ fallbackPolicy: 'resume_local', fallbackLimitWatts: null })],
    });
    const { sweepExpiredControls } = await import('./services/control-delivery');
    const result = await sweepExpiredControls(NOW);
    expect(result.applied).toBe(1);
    expect(h.clearCalls).toHaveLength(1);
    expect(h.fallbackCalls).toHaveLength(0);
  });

  it('records hold_last without commanding the device', async () => {
    const h = await harness({
      rows: [expiredRow({ fallbackPolicy: 'hold_last', fallbackLimitWatts: null })],
    });
    const { sweepExpiredControls } = await import('./services/control-delivery');
    const result = await sweepExpiredControls(NOW);
    expect(result.held).toBe(1);
    expect(result.applied).toBe(0);
    expect(h.held).toEqual([1]);
    expect(h.fallbackCalls).toHaveLength(0);
    expect(h.clearCalls).toHaveLength(0);
  });

  it('records a disconnected charge point as offline, not as applied', async () => {
    const { GridCommandError } = await import('./services/grid-commands');
    const h = await harness({
      rows: [expiredRow()],
      fallbackError: new GridCommandError(503, 'charge point is not connected'),
    });
    const { sweepExpiredControls } = await import('./services/control-delivery');
    const result = await sweepExpiredControls(NOW);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(h.outcomes[0]?.outcome).toBe('device_offline');
  });

  it('records a refused fallback as rejected', async () => {
    const { GridCommandError } = await import('./services/grid-commands');
    const h = await harness({
      rows: [expiredRow()],
      fallbackError: new GridCommandError(409, 'charge point did not accept the command'),
    });
    const { sweepExpiredControls } = await import('./services/control-delivery');
    await sweepExpiredControls(NOW);
    expect(h.outcomes[0]?.outcome).toBe('rejected');
  });

  it('records a timed-out fallback as unconfirmed rather than guessing', async () => {
    const { GridCommandError } = await import('./services/grid-commands');
    const h = await harness({
      rows: [expiredRow()],
      fallbackError: new GridCommandError(504, 'no answer within 20000ms'),
    });
    const { sweepExpiredControls } = await import('./services/control-delivery');
    await sweepExpiredControls(NOW);
    expect(h.outcomes[0]?.outcome).toBe('unconfirmed');
  });

  it('sends nothing when another sweeper already claimed the row', async () => {
    const h = await harness({ rows: [expiredRow()], claimResult: false });
    const { sweepExpiredControls } = await import('./services/control-delivery');
    const result = await sweepExpiredControls(NOW);
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
    expect(h.claims).toEqual([1]);
    expect(h.fallbackCalls).toHaveLength(0);
    expect(h.outcomes).toHaveLength(0);
  });

  it('fails loudly when safe_limit has no watts anywhere', async () => {
    delete process.env.GRID_CONTROL_FALLBACK_LIMIT_W;
    const h = await harness({ rows: [expiredRow({ fallbackLimitWatts: null })] });
    const { sweepExpiredControls } = await import('./services/control-delivery');
    const result = await sweepExpiredControls(NOW);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(h.fallbackCalls).toHaveLength(0);
    expect(h.outcomes[0]?.detail).toMatch(/safe_limit but stored no fallback watts/);
  });
});
