/**
 * Regression tests for MQTT device setpoints. The optimizer used to publish a
 * bare `set_power` with no expiry and no declared fallback, so a device kept the
 * last optimizer target forever if the platform went away. These tests pin the
 * corrected behaviour:
 *  - the command carries its validity window and fallback policy
 *  - a publish the broker took is recorded as broker_queued, never accepted
 *  - a failed publish is recorded and reported as unsent
 *  - an expired MQTT control gets its fallback published, recorded unconfirmed
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const NOW = new Date('2026-03-01T12:00:00.000Z');

interface MqttHarness {
  published: Array<{ deviceId: string; command: string; params: Record<string, unknown> }>;
  error?: Error;
}

async function mockMqtt(state: Partial<MqttHarness> = {}): Promise<MqttHarness> {
  const h: MqttHarness = { published: [], ...state };
  vi.doMock('./integration/mqtt-broker', () => ({
    mqttBrokerService: {
      publishCommand: vi.fn(async (deviceId: string, command: string, params: Record<string, unknown>) => {
        if (h.error) throw h.error;
        h.published.push({ deviceId, command, params });
      }),
    },
  }));
  return h;
}

interface ValidityHarness {
  assignments: Array<Record<string, unknown>>;
  outcomes: Array<{ id: number; reason: string; outcome: string; detail: string }>;
}

async function mockValidity(): Promise<ValidityHarness> {
  const h: ValidityHarness = { assignments: [], outcomes: [] };
  const actual = await import('./services/control-validity');
  vi.doMock('./services/control-validity', () => ({
    ...actual,
    recordControlAssignment: vi.fn(async (input: Record<string, unknown>) => {
      h.assignments.push(input);
      return 21;
    }),
    recordFallbackOutcome: vi.fn(async (id: number, reason: string, outcome: string, detail: string) => {
      h.outcomes.push({ id, reason, outcome, detail });
    }),
  }));
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./integration/mqtt-broker');
  vi.doUnmock('./services/control-validity');
});

describe('dispatchDeviceSetpoint', () => {
  it('publishes the window and the fallback with the setpoint', async () => {
    const mqtt = await mockMqtt();
    const validity = await mockValidity();
    const { dispatchDeviceSetpoint } = await import('./services/control-delivery');

    const result = await dispatchDeviceSetpoint({
      deviceId: 'DEV-1',
      setpointWatts: -3200,
      validFrom: NOW,
      validTo: new Date(NOW.getTime() + 900_000),
      fallbackPolicy: 'resume_local',
      source: 'optimizer',
      assetId: 9,
    });

    expect(result).toMatchObject({ published: true, status: 'broker_queued', assignmentId: 21 });
    expect(mqtt.published).toEqual([
      {
        deviceId: 'DEV-1',
        command: 'set_power',
        params: {
          targetPowerWatts: -3200,
          validFrom: NOW.toISOString(),
          validTo: new Date(NOW.getTime() + 900_000).toISOString(),
          validForSeconds: 900,
          fallbackPolicy: 'resume_local',
          fallbackLimitWatts: null,
        },
      },
    ]);
    // A device that never answers cannot be recorded as having accepted.
    expect(validity.assignments[0]).toMatchObject({
      protocol: 'mqtt',
      targetRef: 'DEV-1',
      source: 'optimizer',
      assetId: 9,
      setpointWatts: -3200,
      delivery: 'broker_queued',
      fallbackPolicy: 'resume_local',
    });
  });

  it('refuses an unbounded setpoint', async () => {
    await mockMqtt();
    await mockValidity();
    const { dispatchDeviceSetpoint } = await import('./services/control-delivery');

    await expect(
      dispatchDeviceSetpoint({
        deviceId: 'DEV-1',
        setpointWatts: 1000,
        fallbackPolicy: 'resume_local',
        source: 'optimizer',
      })
    ).rejects.toThrow(/explicit validTo or validForSeconds/);
  });

  it('records a failed publish as unconfirmed and reports it unsent', async () => {
    const mqtt = await mockMqtt({ error: new Error('MQTT client not connected') });
    const validity = await mockValidity();
    const { dispatchDeviceSetpoint } = await import('./services/control-delivery');

    const result = await dispatchDeviceSetpoint({
      deviceId: 'DEV-1',
      setpointWatts: 2500,
      validForSeconds: 900,
      fallbackPolicy: 'safe_limit',
      fallbackLimitWatts: 0,
      source: 'optimizer',
    });

    expect(result.published).toBe(false);
    expect(result.status).toBe('unconfirmed');
    expect(result.reason).toContain('MQTT client not connected');
    expect(mqtt.published).toHaveLength(0);
    expect(validity.assignments[0]).toMatchObject({
      delivery: 'unconfirmed',
      fallbackLimitWatts: 0,
    });
  });

  it('requires safe_limit watts rather than guessing them', async () => {
    await mockMqtt();
    await mockValidity();
    const previous = process.env.GRID_CONTROL_FALLBACK_LIMIT_W;
    delete process.env.GRID_CONTROL_FALLBACK_LIMIT_W;
    const { dispatchDeviceSetpoint } = await import('./services/control-delivery');

    try {
      await expect(
        dispatchDeviceSetpoint({
          deviceId: 'DEV-1',
          setpointWatts: 2500,
          validForSeconds: 900,
          fallbackPolicy: 'safe_limit',
          source: 'optimizer',
        })
      ).rejects.toThrow(/GRID_CONTROL_FALLBACK_LIMIT_W is not configured/);
    } finally {
      if (previous !== undefined) process.env.GRID_CONTROL_FALLBACK_LIMIT_W = previous;
    }
  });
});

describe('MQTT fallback on expiry', () => {
  const expired = (overrides: Record<string, unknown> = {}) => ({
    id: 21,
    protocol: 'mqtt',
    targetRef: 'DEV-1',
    subTargetRef: 0,
    commandRef: null,
    fallbackPolicy: 'resume_local',
    fallbackLimitWatts: null,
    validFrom: new Date(NOW.getTime() - 900_000),
    validTo: new Date(NOW.getTime() - 60_000),
    ...overrides,
  });

  async function sweep(assignment: Record<string, unknown>) {
    const actual = await import('./services/control-validity');
    const outcomes: Array<{ outcome: string; detail: string }> = [];
    vi.doMock('./services/control-validity', () => ({
      ...actual,
      expiredAssignments: vi.fn(async () => [assignment]),
      claimForFallback: vi.fn(async () => true),
      recordFallbackOutcome: vi.fn(async (_id: number, _reason: string, outcome: string, detail: string) => {
        outcomes.push({ outcome, detail });
      }),
    }));
    const { sweepExpiredControls } = await import('./services/control-delivery');
    return { summary: await sweepExpiredControls(NOW), outcomes };
  }

  it('publishes clear_setpoint for resume_local and never claims the device applied it', async () => {
    const mqtt = await mockMqtt();
    const { summary, outcomes } = await sweep(expired());

    expect(mqtt.published[0]).toMatchObject({ deviceId: 'DEV-1', command: 'clear_setpoint' });
    expect(outcomes[0].outcome).toBe('unconfirmed');
    // Unconfirmed is not a success: the operator view must show it as unfinished.
    expect(summary.applied).toBe(0);
    expect(summary.unconfirmed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('publishes the safe limit for safe_limit', async () => {
    const mqtt = await mockMqtt();
    const { outcomes } = await sweep(
      expired({ fallbackPolicy: 'safe_limit', fallbackLimitWatts: 0 })
    );

    expect(mqtt.published[0]).toMatchObject({
      command: 'set_power',
      params: expect.objectContaining({ targetPowerWatts: 0 }),
    });
    expect(outcomes[0].outcome).toBe('unconfirmed');
  });

  it('refuses to invent watts when safe_limit stored none', async () => {
    await mockMqtt();
    const { outcomes } = await sweep(expired({ fallbackPolicy: 'safe_limit' }));

    expect(outcomes[0].outcome).toBe('unconfirmed');
    expect(outcomes[0].detail).toContain('stored no fallback watts');
  });
});
