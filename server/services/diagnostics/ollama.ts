/**
 * A real client for a local Ollama server.
 *
 * Two Ollama failures look like success if you only check the HTTP status:
 *
 *   - a model that was never pulled answers `POST /api/chat` with 404 and a body
 *     of `{"error":"model 'x' not found, try pulling it first"}`, and
 *   - a reachable server with `stream: true` (the default) returns a stream of
 *     JSON lines, so a naive `res.json()` parses only the first fragment and
 *     yields an empty-looking message.
 *
 * So this client pins `stream: false`, checks that the requested model is present
 * in `/api/tags` before asking anything, and reports every failure as a typed
 * reason with the server's own words. It never substitutes canned text for a
 * model response: callers get `{ ok: false }` and refuse.
 */

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** 0 for deterministic diagnosis; a diagnostic that varies run to run is not evidence. */
  temperature: number;
}

export type OllamaFailure =
  | { kind: 'not_configured'; detail: string }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'model_missing'; detail: string }
  | { kind: 'http_error'; detail: string }
  | { kind: 'bad_response'; detail: string };

export interface OllamaChatResult {
  content: string;
  /** As the server reported it; a requested tag can resolve to another name. */
  model: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export type OllamaResult<T> = { ok: true; value: T } | { ok: false; failure: OllamaFailure };

export interface OllamaHealth {
  configured: boolean;
  baseUrl: string;
  requestedModel: string;
  reachable: boolean;
  /** Models the server actually has locally. Empty when it has none pulled. */
  models: string[];
  modelPresent: boolean;
  version: string | null;
  detail: string;
}

export function loadOllamaConfig(): OllamaConfig | null {
  const baseUrl = (process.env.OLLAMA_URL ?? '').trim().replace(/\/$/, '');
  const model = (process.env.OLLAMA_MODEL ?? '').trim();
  if (!baseUrl || !model) return null;
  const timeout = Number(process.env.OLLAMA_TIMEOUT_MS ?? '');
  const temperature = Number(process.env.OLLAMA_TEMPERATURE ?? '');
  return {
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 120_000,
    temperature: Number.isFinite(temperature) && temperature >= 0 ? temperature : 0,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error
        ? `: ${cause.message}`
        : typeof cause === 'string'
          ? `: ${cause}`
          : '';
    return `${error.message}${causeText}`;
  }
  return String(error);
}

async function request(
  config: OllamaConfig,
  path: string,
  init: RequestInit
): Promise<OllamaResult<Response>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
    return { ok: true, value: response };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        failure: {
          kind: 'timeout',
          detail: `${config.baseUrl}${path} did not answer within ${config.timeoutMs}ms`,
        },
      };
    }
    return {
      ok: false,
      failure: { kind: 'unreachable', detail: `${config.baseUrl}${path}: ${describeError(error)}` },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Body text of a non-2xx response, so the server's own error survives. */
async function errorDetail(response: Response, path: string): Promise<string> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 500);
  } catch {
    body = '<no body>';
  }
  return `${path} answered ${response.status} ${response.statusText}: ${body}`;
}

/**
 * Is a local model actually available? Reported as measurements — reachable, the
 * tags the server listed, whether the requested one is among them — so an
 * operator sees "server up, model not pulled" instead of a bare "unavailable".
 */
export async function ollamaHealth(config: OllamaConfig | null): Promise<OllamaHealth> {
  if (!config) {
    return {
      configured: false,
      baseUrl: '',
      requestedModel: '',
      reachable: false,
      models: [],
      modelPresent: false,
      version: null,
      detail:
        'OLLAMA_URL and OLLAMA_MODEL are unset, so no local model is configured and diagnosis is refused rather than guessed.',
    };
  }

  const base = {
    configured: true,
    baseUrl: config.baseUrl,
    requestedModel: config.model,
  };

  const tags = await request(config, '/api/tags', { method: 'GET' });
  if (!tags.ok) {
    return {
      ...base,
      reachable: false,
      models: [],
      modelPresent: false,
      version: null,
      detail: `Not reachable — ${tags.failure.detail}`,
    };
  }
  if (!tags.value.ok) {
    return {
      ...base,
      reachable: true,
      models: [],
      modelPresent: false,
      version: null,
      detail: await errorDetail(tags.value, '/api/tags'),
    };
  }

  let models: string[] = [];
  try {
    const body = (await tags.value.json()) as { models?: Array<{ name?: unknown }> };
    models = Array.isArray(body.models)
      ? body.models.map(entry => String(entry?.name ?? '')).filter(name => name.length > 0)
      : [];
  } catch (error) {
    return {
      ...base,
      reachable: true,
      models: [],
      modelPresent: false,
      version: null,
      detail: `/api/tags returned unreadable JSON: ${describeError(error)}`,
    };
  }

  // Ollama reports `llama3.1:8b`; `OLLAMA_MODEL=llama3.1` addresses the same
  // model through the implicit `:latest`-style default, so match on the tag too.
  const modelPresent = models.some(
    name => name === config.model || name.split(':')[0] === config.model.split(':')[0]
  );

  let version: string | null = null;
  const versionResponse = await request(config, '/api/version', { method: 'GET' });
  if (versionResponse.ok && versionResponse.value.ok) {
    try {
      const body = (await versionResponse.value.json()) as { version?: unknown };
      version = body.version === undefined ? null : String(body.version);
    } catch {
      version = null;
    }
  }

  return {
    ...base,
    reachable: true,
    models,
    modelPresent,
    version,
    detail: modelPresent
      ? `Reachable${version ? ` (ollama ${version})` : ''} with ${config.model} pulled.`
      : `Reachable${version ? ` (ollama ${version})` : ''} but ${config.model} is not pulled; the server has ${
          models.length === 0 ? 'no models' : models.join(', ')
        }. Run: ollama pull ${config.model}`,
  };
}

/**
 * One non-streaming chat completion. `format: 'json'` makes Ollama constrain the
 * output to JSON, but the caller still parses and validates it — a model can emit
 * well-formed JSON with invented fields.
 */
export async function ollamaChat(
  config: OllamaConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  options: { json?: boolean } = {}
): Promise<OllamaResult<OllamaChatResult>> {
  const started = Date.now();
  const response = await request(config, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      ...(options.json ? { format: 'json' } : {}),
      options: { temperature: config.temperature },
    }),
  });
  if (!response.ok) return response;

  if (!response.value.ok) {
    const detail = await errorDetail(response.value, '/api/chat');
    return {
      ok: false,
      failure: {
        kind: response.value.status === 404 ? 'model_missing' : 'http_error',
        detail,
      },
    };
  }

  let body: {
    message?: { content?: unknown };
    model?: unknown;
    done?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
  };
  try {
    body = (await response.value.json()) as typeof body;
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'bad_response',
        detail: `/api/chat returned unreadable JSON: ${describeError(error)}`,
      },
    };
  }

  const content = typeof body.message?.content === 'string' ? body.message.content : '';
  if (content.trim().length === 0) {
    return {
      ok: false,
      failure: {
        kind: 'bad_response',
        detail: '/api/chat returned an empty message; nothing was generated to report.',
      },
    };
  }

  const promptTokens = Number(body.prompt_eval_count);
  const completionTokens = Number(body.eval_count);
  return {
    ok: true,
    value: {
      content,
      model: typeof body.model === 'string' && body.model.length > 0 ? body.model : config.model,
      latencyMs: Date.now() - started,
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : null,
    },
  };
}
