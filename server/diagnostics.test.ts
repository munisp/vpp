/**
 * A diagnostic assistant is the easiest place in a platform to ship convincing
 * fiction: the output is prose, nobody diffs it, and every failure mode — no
 * model, no database, no lake — has a plausible-sounding answer available. These
 * tests pin the refusals and the citation check, which are the only things
 * standing between an operator and confident invented advice.
 */

import { afterEach, beforeEach, describe as suite, expect, it, vi } from 'vitest';

import {
  loadOllamaConfig,
  ollamaChat,
  ollamaHealth,
  type OllamaConfig,
} from './services/diagnostics/ollama';
import { digestEvidence, evidencePrompt, validateFindings } from './services/diagnostics/diagnose';
import type { EvidenceBundle, Observation } from './services/diagnostics/evidence';
import {
  availabilityCopy,
  diagnosticStateCopy,
  latencyLabel,
  measureLabel,
  modelStatusCopy,
} from '../shared/diagnostics-state';

const CONFIG: OllamaConfig = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.1:8b',
  timeoutMs: 50,
  temperature: 0,
};

function observation(id: string, available = true): Observation {
  return {
    id,
    area: 'events',
    title: id,
    available,
    measures: { rows: 3 },
    source: 'event_outbox',
    detail: 'measured',
  };
}

function bundle(observations: Observation[]): EvidenceBundle {
  const availableCount = observations.filter(entry => entry.available).length;
  return {
    collectedAt: '2026-08-22T12:00:00.000Z',
    observations,
    availableCount,
    unavailableCount: observations.length - availableCount,
    detail: 'test bundle',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

suite('ollama configuration', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('is unconfigured — not defaulted to a guessed endpoint — when the env is unset', () => {
    delete process.env.OLLAMA_URL;
    delete process.env.OLLAMA_MODEL;
    expect(loadOllamaConfig()).toBeNull();
  });

  it('refuses a URL without a model: half a configuration cannot answer', () => {
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    delete process.env.OLLAMA_MODEL;
    expect(loadOllamaConfig()).toBeNull();
  });

  it('defaults generation to temperature 0, so a diagnosis does not vary run to run', () => {
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434/';
    process.env.OLLAMA_MODEL = 'llama3.1:8b';
    delete process.env.OLLAMA_TEMPERATURE;
    const config = loadOllamaConfig();
    expect(config?.temperature).toBe(0);
    expect(config?.baseUrl).toBe('http://127.0.0.1:11434');
  });
});

suite('ollama health', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports "not configured" as its own state rather than as an outage', async () => {
    const health = await ollamaHealth(null);
    expect(health.configured).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.detail).toContain('OLLAMA_URL');
  });

  it('reports an unreachable server with the connection error, not as "no findings"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED 127.0.0.1:11434') });
      })
    );
    const health = await ollamaHealth(CONFIG);
    expect(health.reachable).toBe(false);
    expect(health.detail).toContain('ECONNREFUSED');
  });

  it('separates "server up" from "model pulled", so pulling advice is actionable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/tags')
          ? jsonResponse({ models: [{ name: 'qwen2.5:3b' }] })
          : jsonResponse({ version: '0.3.12' })
      )
    );
    const health = await ollamaHealth(CONFIG);
    expect(health.reachable).toBe(true);
    expect(health.modelPresent).toBe(false);
    expect(health.models).toEqual(['qwen2.5:3b']);
    expect(health.detail).toContain('ollama pull llama3.1:8b');
    expect(modelStatusCopy(health)).toEqual({ label: 'model not pulled', tone: 'danger' });
  });

  it('matches a model addressed without its tag against the tag the server reports', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/tags')
          ? jsonResponse({ models: [{ name: 'llama3.1:8b' }] })
          : jsonResponse({ version: '0.3.12' })
      )
    );
    const health = await ollamaHealth({ ...CONFIG, model: 'llama3.1' });
    expect(health.modelPresent).toBe(true);
    expect(modelStatusCopy(health).label).toBe('available');
  });

  it('treats unreadable /api/tags JSON as unknown, never as an empty model list that is fine', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>proxy error</html>', { status: 200 })
      )
    );
    const health = await ollamaHealth(CONFIG);
    expect(health.modelPresent).toBe(false);
    expect(health.detail).toContain('unreadable JSON');
  });
});

suite('ollama chat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never streams: a streamed body would parse as an empty answer', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ model: 'llama3.1:8b', message: { content: '{"summary":"ok"}' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await ollamaChat(CONFIG, [{ role: 'user', content: 'hello' }], { json: true });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.stream).toBe(false);
    expect(body.format).toBe('json');
    expect(body.options.temperature).toBe(0);
  });

  it('classifies a 404 from /api/chat as the missing model it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: "model 'llama3.1:8b' not found" }, 404))
    );
    const result = await ollamaChat(CONFIG, [{ role: 'user', content: 'x' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('model_missing');
      expect(result.failure.detail).toContain('not found');
    }
  });

  it('keeps a server-side error as an error, with the server\'s own words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('out of memory', { status: 500, statusText: 'Server Error' }))
    );
    const result = await ollamaChat(CONFIG, [{ role: 'user', content: 'x' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('http_error');
      expect(result.failure.detail).toContain('out of memory');
    }
  });

  it('reports a timeout as a timeout rather than as an empty diagnosis', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
            );
          })
      )
    );
    const result = await ollamaChat({ ...CONFIG, timeoutMs: 10 }, [{ role: 'user', content: 'x' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('timeout');
  });

  it('refuses an empty message: 200 OK with no content generated nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ model: 'llama3.1:8b', message: { content: '   ' } }))
    );
    const result = await ollamaChat(CONFIG, [{ role: 'user', content: 'x' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('bad_response');
  });

  it('records the model the server answered with, not the one that was asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          model: 'llama3.1:8b-instruct-q4_K_M',
          message: { content: '{"summary":"ok","findings":[]}' },
          prompt_eval_count: 812,
          eval_count: 96,
        })
      )
    );
    const result = await ollamaChat({ ...CONFIG, model: 'llama3.1' }, [
      { role: 'user', content: 'x' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe('llama3.1:8b-instruct-q4_K_M');
      expect(result.value.promptTokens).toBe(812);
    }
  });
});

suite('finding validation', () => {
  const observations = [observation('events.outbox_backlog'), observation('ledger.unposted')];

  it('keeps a finding that cites evidence it was actually given', () => {
    const result = validateFindings(
      JSON.stringify({
        summary: 'Events are backing up.',
        findings: [
          {
            title: 'Outbox relay stopped',
            hypothesis: 'The relay is not claiming rows.',
            recommendedAction: 'Check the relay process and its last claim time.',
            confidence: 'high',
            observationIds: ['events.outbox_backlog'],
          },
        ],
      }),
      observations
    );
    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.rejectedCitations).toBe(0);
  });

  it('drops a citation to an observation that was never supplied, and counts it', () => {
    const result = validateFindings(
      JSON.stringify({
        summary: '',
        findings: [
          {
            title: 'Kafka consumer lag',
            hypothesis: 'Lag is rising.',
            recommendedAction: 'Inspect consumer offsets.',
            confidence: 'high',
            observationIds: ['events.outbox_backlog', 'kafka.consumer_lag'],
          },
        ],
      }),
      observations
    );
    expect(result.findings[0]?.observationIds).toEqual(['events.outbox_backlog']);
    expect(result.rejectedCitations).toBe(1);
  });

  it('discards a finding whose every citation was invented, rather than showing it uncited', () => {
    const result = validateFindings(
      JSON.stringify({
        summary: 'Grid frequency is unstable.',
        findings: [
          {
            title: 'Frequency excursion',
            hypothesis: 'Frequency left its band.',
            recommendedAction: 'Look at the frequency feed.',
            confidence: 'high',
            observationIds: ['grid.frequency', 'grid.rocof'],
          },
        ],
      }),
      observations
    );
    expect(result.findings).toEqual([]);
    expect(result.rejectedCitations).toBe(2);
  });

  it('does not upgrade an unrecognised confidence value', () => {
    const result = validateFindings(
      JSON.stringify({
        summary: '',
        findings: [
          {
            title: 'Unposted settlements',
            hypothesis: 'Ledger writes are failing.',
            recommendedAction: 'Check the ledger client.',
            confidence: 'certain',
            observationIds: ['ledger.unposted'],
          },
        ],
      }),
      observations
    );
    expect(result.findings[0]?.confidence).toBe('low');
  });

  it('reports unparseable output as a parse error instead of inventing a summary', () => {
    const result = validateFindings('I looked at your platform and it seems fine.', observations);
    expect(result.parseError).not.toBeNull();
    expect(result.findings).toEqual([]);
  });

  it('rejects a JSON array, which carries no summary or findings', () => {
    const result = validateFindings('[]', observations);
    expect(result.parseError).toBe('not a JSON object');
  });

  it('drops a finding missing its action: advice with no step is not actionable', () => {
    const result = validateFindings(
      JSON.stringify({
        summary: '',
        findings: [
          {
            title: 'Something is wrong',
            hypothesis: 'Unclear.',
            confidence: 'high',
            observationIds: ['ledger.unposted'],
          },
        ],
      }),
      observations
    );
    expect(result.findings).toEqual([]);
  });
});

suite('evidence digest and prompt', () => {
  it('digests the measurements, so the same evidence digests the same twice', () => {
    const first = bundle([observation('a'), observation('b')]);
    const second = bundle([observation('a'), observation('b')]);
    expect(digestEvidence(first)).toBe(digestEvidence(second));
  });

  it('changes the digest when a measurement changes, so a stored run cannot be re-read wrongly', () => {
    const before = bundle([observation('a')]);
    const after = bundle([{ ...observation('a'), measures: { rows: 4 } }]);
    expect(digestEvidence(before)).not.toBe(digestEvidence(after));
  });

  it('tells the model which sources could not be read, with their ids', () => {
    const prompt = evidencePrompt(
      bundle([observation('events.outbox_backlog'), observation('ledger.unposted', false)]),
      'why is settlement stuck?'
    );
    expect(prompt).toContain('id: events.outbox_backlog');
    expect(prompt).toContain('available: false');
    expect(prompt).toContain('1 readable, 1 unreadable');
  });
});

suite('diagnostic state copy', () => {
  it('never renders an unreadable source as healthy', () => {
    expect(availabilityCopy(false)).toEqual({ label: 'unreadable', tone: 'danger' });
  });

  it('renders a refusal as a refusal, not as an all-clear', () => {
    expect(diagnosticStateCopy('refused').label).toBe('refused');
    expect(diagnosticStateCopy('refused').tone).toBe('warning');
  });

  it('renders an unknown measurement as unknown rather than zero', () => {
    expect(measureLabel(null)).toBe('unknown');
    expect(measureLabel(0)).toBe('0');
    expect(latencyLabel(null)).toBe('—');
  });
});

suite('diagnose orchestration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('./db');
    vi.doUnmock('./services/lakehouse/status');
  });

  async function loadDiagnose() {
    // No database: every probe reports unavailable, which is the state a
    // diagnosis must refuse on rather than answer around.
    vi.doMock('./db', () => ({ getDb: async () => null }));
    vi.doMock('./services/lakehouse/status', () => ({
      lakehouseStatus: async () => {
        throw new Error('no database connection');
      },
      LAKEHOUSE_DATASETS: [],
    }));
    return import('./services/diagnostics/diagnose');
  }

  it('refuses when no local model is configured, and says so', async () => {
    delete process.env.OLLAMA_URL;
    delete process.env.OLLAMA_MODEL;
    const { diagnose } = await loadDiagnose();
    const result = await diagnose({ question: 'why is settlement stuck?', requestedBy: 1 });
    expect(result.state).toBe('refused');
    if (result.state === 'refused') {
      expect(result.reason).toContain('OLLAMA_URL');
      // Losing the audit row must not be reported as a model failure.
      expect(result.runId).toBeNull();
    }
  });

  it('refuses when no observation could be read, without asking the model', async () => {
    process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
    process.env.OLLAMA_MODEL = 'llama3.1:8b';
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/api/tags')
        ? jsonResponse({ models: [{ name: 'llama3.1:8b' }] })
        : String(url).includes('/api/version')
          ? jsonResponse({ version: '0.3.12' })
          : jsonResponse({ model: 'llama3.1:8b', message: { content: '{"summary":"fine"}' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { diagnose } = await loadDiagnose();
    const result = await diagnose({ question: 'why is settlement stuck?', requestedBy: 1 });
    expect(result.state).toBe('refused');
    if (result.state === 'refused') {
      expect(result.reason).toContain('No observation could be read');
      expect(result.evidence.availableCount).toBe(0);
      expect(result.evidence.unavailableCount).toBeGreaterThan(0);
    }
    expect(
      fetchMock.mock.calls.some(call => String(call[0]).includes('/api/chat'))
    ).toBe(false);
  });
});
