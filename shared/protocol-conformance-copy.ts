/**
 * One vocabulary for protocol conformance, shared by the PWA and the mobile app.
 *
 * The distinction that matters is between a protocol this platform has *shown*
 * it speaks correctly and a protocol somebody *listed* on an asset. Only the
 * first is `proven`. Everything else — never tested, tested and failed, tested
 * with cases skipped, or proven so long ago the evidence has gone stale — reads
 * as unproven, and an operator must be able to see that before they let a
 * dispatch or a certification lean on it.
 */

export type ConformanceAdapter =
  | 'ocpp16'
  | 'ocpp201'
  | 'openadr2b'
  | 'ieee2030_5'
  | 'modbus_sunspec'
  | 'matter';

export const CONFORMANCE_ADAPTERS: readonly ConformanceAdapter[] = [
  'ocpp16',
  'ocpp201',
  'openadr2b',
  'ieee2030_5',
  'modbus_sunspec',
  'matter',
];

export const CONFORMANCE_ADAPTER_LABELS: Record<ConformanceAdapter, string> = {
  ocpp16: 'OCPP 1.6J',
  ocpp201: 'OCPP 2.0.1',
  openadr2b: 'OpenADR 2.0b',
  ieee2030_5: 'IEEE 2030.5 (SEP2)',
  modbus_sunspec: 'Modbus / SunSpec',
  matter: 'Matter',
};

/**
 * `no_suite` is honest about the platform, not the device: MQTT setpoints have
 * no conformance vector set here, so no run can exist and the surface says so
 * rather than implying the device failed a test nobody wrote.
 */
export type ProtocolProofState =
  | 'proven'
  | 'claimed_unproven'
  | 'suite_failed'
  | 'proof_stale'
  | 'no_suite';

export type Tone = 'good' | 'warning' | 'bad' | 'neutral';

export interface ProofCopy {
  label: string;
  tone: Tone;
  /** What a reader may conclude — and, when unproven, what they may not. */
  meaning: string;
}

export const PROTOCOL_PROOF_COPY: Record<ProtocolProofState, ProofCopy> = {
  proven: {
    label: 'Proven',
    tone: 'good',
    meaning:
      'A conformance run exercised every case in the vector set against a simulator or a device, and all of them passed. The run, its cases and its artifact checksum are recorded.',
  },
  claimed_unproven: {
    label: 'Claimed, unproven',
    tone: 'warning',
    meaning:
      'The protocol is listed on the asset but no passing conformance run exists for it. Nothing here says the wire works; a dispatch over it is labelled unproven on the control record.',
  },
  suite_failed: {
    label: 'Failed conformance',
    tone: 'bad',
    meaning:
      'The most recent run of this vector set failed at least one case. The failing cases are recorded; treat the protocol as broken until a later run passes.',
  },
  proof_stale: {
    label: 'Proof expired',
    tone: 'warning',
    meaning:
      'The last passing run is older than the deployment’s evidence window. It proved the adapter as it was then, not as it is now, so it no longer counts as proof.',
  },
  no_suite: {
    label: 'No vector set',
    tone: 'neutral',
    meaning:
      'This platform has no conformance vector set for this protocol, so there is nothing to run and nothing to prove. Not a failure — an absence.',
  },
};

/** Proof states that permit a surface to describe a capability as available. */
export function isProven(state: ProtocolProofState): boolean {
  return state === 'proven';
}

export type ConformanceRunOutcome = 'passed' | 'failed' | 'refused';

export const CONFORMANCE_OUTCOME_COPY: Record<ConformanceRunOutcome, ProofCopy> = {
  passed: {
    label: 'Passed',
    tone: 'good',
    meaning: 'Every case in the vector set passed. Nothing was skipped.',
  },
  failed: {
    label: 'Failed',
    tone: 'bad',
    meaning: 'At least one case failed, or cases were skipped, so the suite proves nothing.',
  },
  refused: {
    label: 'Refused',
    tone: 'warning',
    meaning:
      'The runner would not stand behind the result — the peer was unreachable, the vector set would not load, or the artifact could not be checksummed. Recorded so the attempt is visible.',
  },
};
