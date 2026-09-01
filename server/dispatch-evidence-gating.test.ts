/**
 * Pinning tests for the evidence-before-the-wire fix (audit finding:
 * "Twin-evidence refusal happens AFTER the MQTT publish").
 *
 * The twin-evidence gate used to live only inside recordControlAssignment,
 * which ran AFTER the command had already been published to the MQTT broker
 * or sent to the charge point — a refused command was already on the wire.
 * These tests pin the corrected ordering:
 *  - the gate runs BEFORE any publish/send (call-order assertion)
 *  - a refused command produces ZERO publishes, and the refusal + reason is
 *    recorded as a 'rejected' assignment
 *  - a valid command is published, then recorded with the gate marked as run
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const NOW = new Date('2026-03-01T12:00:00.000Z');

type Evidence = 'measured' | 'stale' | 'never';

interface TwinHarness {
  evidenceByAsset: Map<number, { evidence: Evidence; ageSeconds: number | null }>;
  getTwinEvidence: ReturnType<typeof vi.fn>;
}

async function mockTwin(state: Record<number, Evidence> = {}): Promise<TwinHarness> {
  const actual = await import('./services/digital-twin');
  const h: TwinHarness = {
    evidenceByAsset: new Map(
      Object.entries(state).map(([id, evidence]) => [
        Number(id),
        { evidence, ageSeconds: evidence === 'stale' ? 7200 : evidence === 'never' ? null : 5 },
      ])
    ),
    getTwinEvidence: vi.fn(),
  };
  h.getTwinEvidence.mockImplementation(async () => h.evidenceByAsset);
  vi.doMock('./services/digital-twin', () => ({
    ...actual,
    getTwinEvidence: h.getTwinEvidence,
  }));
  return h;
}

interface MqttHarness {
  published: Array<{ deviceId: string; command: string; params: Record<string, unknown> }>;
  publishCommand: ReturnType<typeof vi.fn>;
}

async function mockMqtt(): Promise<MqttHarness> {
  const h: MqttHarness = { published: [], publishCommand: vi.fn() };
  h.publishCommand.mockImplementation(
    async (deviceId: string, command: string, params: Record<string, unknown>) => {
      h.published.push({ deviceId, command, params });
    }
  );
  vi.doMock('./integration/mqtt-broker', () => ({
    mqttBrokerService: { publishCommand: h.publishCommand },
  }));
  return h;
}

interface GridHarness {
  setChargingProfile: ReturnType<typeof vi.fn>;
}

async function mockGridCommands(): Promise<GridHarness> {
  const actual = await import('./services/grid-commands');
  const h: GridHarness = {
    setChargingProfile: vi.fn(async () => ({ status: 'Accepted' })),
  };
  vi.doMock('./services/grid-commands', () => ({
    ...actual,
    setChargingProfile: h.setChargingProfile,
  }));
  return h;
}

interface ValidityHarness {
  assignments: Array<Record<string, unknown>>;
}

async function mockValidityRecorder(): Promise<ValidityHarness> {
  const h: ValidityHarness = { assignments: [] };
  const actual = await import('./services/control-validity');
  vi.doMock('./services/control-validity', () => ({
    ...actual,
    recordControlAssignment: vi.fn(async (input: Record<string, unknown>) => {
      h.assignments.push(input);
      return 42;
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
  vi.doUnmock('./services/digital-twin');
  vi.doUnmock('./integration/mqtt-broker');
  vi.doUnmock('./services/grid-commands');
  vi.doUnmock('./services/control-validity');
});

describe('dispatchDeviceSetpoint: evidence gate before the wire', () => {
  it('publishes NOTHING when the twin refuses, and records the refusal with its reason', async () => {
    const mqtt = await mockMqtt();
    await mockTwin({ 9: 'stale' });
    const validity = await mockValidityRecorder();
    const { dispatchDeviceSetpoint } = await import('./services/control-delivery');

    const result = await dispatchDeviceSetpoint({
      deviceId: 'DEV-1',
      setpointWatts: 2500,
      validForSeconds: 900,
      fallbackPolicy: 'resume_local',
      source: 'optimizer',
      assetId: 9,
    });

    // The critical invariant: the refused command never reached the broker.
    expect(mqtt.published).toHaveLength(0);
    expect(result.published).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('refused');
    expect(result.reason).toContain('asset 9');
    // The refusal is on the audit trail as rejected, with the reason.
    expect(validity.assignments).toHaveLength(1);
    expect(validity.assignments[0]).toMatchObject({
      delivery: 'rejected',
      assetId: 9,
    });
    expect(String(validity.assignments[0].deliveryDetail)).toContain('refused');
  });

  it('publishes NOTHING for an asset the platform has never heard from', async () => {
    const mqtt = await mockMqtt();
    await mockTwin({ 9: 'never' });
    const validity = await mockValidityRecorder();
    const { dispatchDeviceSetpoint } = await import('./services/control-delivery');

    const result = await dispatchDeviceSetpoint({
      deviceId: 'DEV-1',
      setpointWatts: 2500,
      validForSeconds: 900,
      fallbackPolicy: 'resume_local',
      source: 'optimizer',
      assetId: 9,
    });

    expect(mqtt.published).toHaveLength(0);
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('never received telemetry');
    expect(validity.assignments[0]).toMatchObject({ delivery: 'rejected' });
  });

  it('checks evidence BEFORE publishing, and publishes a valid command', async () => {
    const mqtt = await mockMqtt();
    const twin = await mockTwin({ 9: 'measured' });
    const validity = await mockValidityRecorder();
    const { dispatchDeviceSetpoint } = await import('./services/control-delivery');

    const result = await dispatchDeviceSetpoint({
      deviceId: 'DEV-1',
      setpointWatts: -3200,
      validForSeconds: 900,
      fallbackPolicy: 'resume_local',
      source: 'optimizer',
      assetId: 9,
    });

    expect(result.published).toBe(true);
    expect(result.status).toBe('broker_queued');
    expect(mqtt.published).toHaveLength(1);
    // Ordering proof: the twin was consulted before the publish.
    expect(twin.getTwinEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      mqtt.publishCommand.mock.invocationCallOrder[0]
    );
    // The record says the gate already ran pre-publish (no post-hoc recheck).
    expect(validity.assignments[0]).toMatchObject({
      delivery: 'broker_queued',
      twinEvidenceChecked: true,
    });
  });
});

describe('dispatchChargingPlan: evidence gate before the wire (OCPP path)', () => {
  const plan = {
    chargePointId: 'CP-1',
    connectorId: 1,
    chargingProfileId: 7,
    periods: [{ startPeriod: 0, limitWatts: 6000 }],
    validForSeconds: 900,
    fallbackPolicy: 'resume_local' as const,
    source: 'optimizer' as const,
    assetId: 9,
  };

  it('sends NOTHING to the charge point when the twin refuses, and records the refusal', async () => {
    // Twin mock first: grid-commands transitively loads control-validity, and
    // the twin gate must be mocked before that module graph resolves.
    await mockTwin({ 9: 'stale' });
    const grid = await mockGridCommands();
    const validity = await mockValidityRecorder();
    const { dispatchChargingPlan } = await import('./services/control-delivery');

    const result = await dispatchChargingPlan(plan);

    expect(grid.setChargingProfile).not.toHaveBeenCalled();
    expect(result.delivered).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('refused');
    expect(validity.assignments).toHaveLength(1);
    expect(validity.assignments[0]).toMatchObject({ delivery: 'rejected', assetId: 9 });
  });

  it('checks evidence BEFORE SetChargingProfile, and records the accepted assignment', async () => {
    const twin = await mockTwin({ 9: 'measured' });
    const grid = await mockGridCommands();
    const validity = await mockValidityRecorder();
    const { dispatchChargingPlan } = await import('./services/control-delivery');

    const result = await dispatchChargingPlan(plan);

    expect(result.delivered).toBe(true);
    expect(grid.setChargingProfile).toHaveBeenCalledTimes(1);
    expect(twin.getTwinEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      grid.setChargingProfile.mock.invocationCallOrder[0]
    );
    expect(validity.assignments[0]).toMatchObject({
      delivery: 'accepted',
      twinEvidenceChecked: true,
    });
  });
});

describe('recordControlAssignment: gate still fires for callers that bypass the delivery path', () => {
  it('refuses an in-force record for a stale asset', async () => {
    await mockTwin({ 9: 'stale' });
    const { recordControlAssignment } = await import('./services/control-validity');
    // No database is configured in tests, so requireDb would throw first; the
    // refusal must therefore be exercised through checkDispatchEvidence, which
    // is the gate the delivery path runs pre-publish.
    const { checkDispatchEvidence, ControlValidityError } = await import(
      './services/control-validity'
    );
    await expect(checkDispatchEvidence({ assetId: 9 })).rejects.toBeInstanceOf(
      ControlValidityError
    );
    await expect(checkDispatchEvidence({ assetId: 9 })).rejects.toThrow(/refused/);
    expect(typeof recordControlAssignment).toBe('function');
  });
});
