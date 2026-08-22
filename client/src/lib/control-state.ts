/**
 * Shared vocabulary for control windows in the UI.
 *
 * The wording here is load-bearing: a control the platform published to a broker
 * without a device answer must not read as "confirmed", and a window that closed
 * without its fallback landing must not read as finished. Anything that reduces
 * these states to a green tick would recreate exactly the class of bug this
 * subsystem exists to prevent.
 */

export type ControlState =
  | 'no_control'
  | 'scheduled'
  | 'active'
  | 'expiring'
  | 'expired_awaiting_fallback'
  | 'fallback_applied'
  | 'fallback_failed'
  | 'held_past_window'
  | 'rejected';

export type ControlDelivery = 'accepted' | 'broker_queued' | 'rejected' | 'unconfirmed';

export type ControlTone = 'live' | 'warning' | 'danger' | 'neutral';

export interface StateCopy {
  label: string;
  tone: ControlTone;
  /** What the operator or owner should understand is physically true. */
  meaning: string;
}

export const CONTROL_STATE_COPY: Record<ControlState, StateCopy> = {
  active: {
    label: 'Active',
    tone: 'live',
    meaning: 'The device is inside a maintained control window.',
  },
  expiring: {
    label: 'Expiring',
    tone: 'warning',
    meaning: 'The window closes shortly; without a refresh the fallback runs.',
  },
  scheduled: {
    label: 'Scheduled',
    tone: 'neutral',
    meaning: 'Accepted by the device but its window has not opened yet.',
  },
  expired_awaiting_fallback: {
    label: 'Expired — fallback pending',
    tone: 'danger',
    meaning: 'The window closed and the fallback has not been delivered yet.',
  },
  fallback_applied: {
    label: 'Fallback applied',
    tone: 'neutral',
    meaning: 'The window closed and the device returned to its fallback.',
  },
  fallback_failed: {
    label: 'Fallback failed',
    tone: 'danger',
    meaning: 'The fallback was refused or unconfirmed; the asset may still hold the expired setpoint.',
  },
  held_past_window: {
    label: 'Held past window',
    tone: 'warning',
    meaning: 'hold_last: the expired setpoint is deliberately still running and is not a safe state.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'neutral',
    meaning: 'The device refused this command; nothing was applied.',
  },
  no_control: {
    label: 'Superseded',
    tone: 'neutral',
    meaning: 'Replaced by a later control for the same target.',
  },
};

export const CONTROL_DELIVERY_COPY: Record<ControlDelivery, StateCopy> = {
  accepted: {
    label: 'Device confirmed',
    tone: 'live',
    meaning: 'The hardware answered and accepted the command.',
  },
  broker_queued: {
    label: 'Sent, unconfirmed by device',
    tone: 'warning',
    meaning: 'The MQTT broker took the message; the device does not acknowledge commands.',
  },
  unconfirmed: {
    label: 'Delivery unknown',
    tone: 'danger',
    meaning: 'The platform cannot establish that the command reached the device.',
  },
  rejected: {
    label: 'Refused',
    tone: 'neutral',
    meaning: 'The device explicitly refused the command.',
  },
};

/** Countdown text; negative values read as overdue, never as zero. */
export function formatRemaining(seconds: number): string {
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const parts = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  return seconds < 0 ? `${parts} overdue` : parts;
}

export function formatWatts(watts: number | null | undefined): string {
  if (watts === null || watts === undefined) return '—';
  const kw = watts / 1000;
  const direction = watts > 0 ? 'export' : watts < 0 ? 'import' : 'idle';
  return `${kw.toFixed(2)} kW ${direction}`;
}

export const FALLBACK_COPY: Record<string, string> = {
  safe_limit: 'Falls back to a fixed safe limit',
  resume_local: 'Falls back to the device’s own local control',
  hold_last: 'Keeps the last setpoint — not a safe state',
};
