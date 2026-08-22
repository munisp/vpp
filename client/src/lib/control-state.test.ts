import { describe, expect, it } from 'vitest';
import {
  CONTROL_DELIVERY_COPY,
  CONTROL_STATE_COPY,
  formatRemaining,
  formatWatts,
  type ControlDelivery,
  type ControlState,
} from './control-state';

describe('control state copy', () => {
  it('never presents an unmaintained window as a healthy state', () => {
    const unsafe: ControlState[] = [
      'expired_awaiting_fallback',
      'fallback_failed',
      'held_past_window',
      'expiring',
    ];
    for (const state of unsafe) {
      expect(CONTROL_STATE_COPY[state].tone).not.toBe('live');
    }
  });

  it('only calls a control live when the device is inside its window', () => {
    const live = (Object.keys(CONTROL_STATE_COPY) as ControlState[]).filter(
      state => CONTROL_STATE_COPY[state].tone === 'live'
    );
    expect(live).toEqual(['active']);
  });

  it('reserves device confirmation for deliveries the hardware answered', () => {
    const confirmed = (Object.keys(CONTROL_DELIVERY_COPY) as ControlDelivery[]).filter(
      delivery => CONTROL_DELIVERY_COPY[delivery].tone === 'live'
    );
    expect(confirmed).toEqual(['accepted']);
    expect(CONTROL_DELIVERY_COPY.broker_queued.label).toMatch(/unconfirmed/i);
  });
});

describe('formatRemaining', () => {
  it('marks a closed window as overdue rather than zero', () => {
    expect(formatRemaining(-90)).toBe('1m 30s overdue');
  });

  it('formats hours, minutes and seconds', () => {
    expect(formatRemaining(3720)).toBe('1h 2m');
    expect(formatRemaining(125)).toBe('2m 5s');
    expect(formatRemaining(9)).toBe('9s');
  });
});

describe('formatWatts', () => {
  it('shows sign as direction and blanks unknown setpoints', () => {
    expect(formatWatts(5000)).toBe('5.00 kW export');
    expect(formatWatts(-3200)).toBe('-3.20 kW import');
    expect(formatWatts(0)).toBe('0.00 kW idle');
    expect(formatWatts(null)).toBe('—');
  });
});
