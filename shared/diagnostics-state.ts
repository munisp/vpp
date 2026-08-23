/**
 * One copy map for diagnostic state, shared by the web console and the mobile app.
 *
 * The distinction both surfaces must keep is between an answer and a refusal. A
 * refusal is not an error page and not an empty result: it is the platform saying
 * that a local model or the evidence behind an answer was missing, which is itself
 * the diagnosis. Nothing here softens that into "no issues found".
 */

export type Tone = 'good' | 'warning' | 'danger' | 'neutral';

export type DiagnosticState = 'succeeded' | 'refused' | 'failed';

export const DIAGNOSTIC_STATE_COPY: Record<
  DiagnosticState,
  { label: string; tone: Tone; meaning: string }
> = {
  succeeded: {
    label: 'answered',
    tone: 'good',
    meaning:
      'The local model answered from the observations listed with the run, and every finding cites observations that were actually supplied.',
  },
  refused: {
    label: 'refused',
    tone: 'warning',
    meaning:
      'No answer was produced, and the reason is recorded: no local model, an unreachable one, a model that is not pulled, or no readable evidence to reason from.',
  },
  failed: {
    label: 'failed',
    tone: 'danger',
    meaning: 'The run itself errored before it could refuse or answer.',
  },
};

export function diagnosticStateCopy(state: string): { label: string; tone: Tone; meaning: string } {
  return (
    DIAGNOSTIC_STATE_COPY[state as DiagnosticState] ?? {
      label: state,
      tone: 'neutral',
      meaning: 'A run state this build does not recognise.',
    }
  );
}

export const CONFIDENCE_TONE: Record<string, Tone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

/** How an observation is labelled. `false` is unknown, never healthy. */
export function availabilityCopy(available: boolean): { label: string; tone: Tone } {
  return available
    ? { label: 'measured', tone: 'good' }
    : { label: 'unreadable', tone: 'danger' };
}

export function modelStatusCopy(health: {
  configured: boolean;
  reachable: boolean;
  modelPresent: boolean;
}): { label: string; tone: Tone } {
  if (!health.configured) return { label: 'not configured', tone: 'danger' };
  if (!health.reachable) return { label: 'unreachable', tone: 'danger' };
  if (!health.modelPresent) return { label: 'model not pulled', tone: 'danger' };
  return { label: 'available', tone: 'good' };
}

export function latencyLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function measureLabel(value: number | string | null): string {
  if (value === null) return 'unknown';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return value;
}

export function whenLabel(value: string | Date | null): string {
  if (!value) return 'never';
  const at = value instanceof Date ? value : new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleString() : 'unknown';
}
