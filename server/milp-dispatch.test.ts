/**
 * The MILP optimizer client must never turn a failed solve into a schedule:
 *  - non-optimal statuses and HTTP errors raise
 *  - production without OPTIMIZER_SERVICE_URL is refused
 *  - the shared token is sent when configured
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  MilpDispatchRequest,
  MilpOptimizerError,
  assertMilpOptimizerConfigured,
  isMilpOptimizerConfigured,
  solveMilpDispatch,
} from './services/milp-dispatch';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const REQUEST: MilpDispatchRequest = {
  interval_minutes: 60,
  site: {
    site_id: 'user-1',
    assets: [],
    load_w: [1000],
    max_import_w: 5000,
    max_export_w: 5000,
  },
  prices: { import_cents_per_kwh: [10], export_cents_per_kwh: [0] },
  objective: 'minimize_cost',
};

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('assertMilpOptimizerConfigured', () => {
  it('refuses to run production dispatch on the heuristic engine', () => {
    delete process.env.OPTIMIZER_SERVICE_URL;
    process.env.NODE_ENV = 'production';
    expect(() => assertMilpOptimizerConfigured()).toThrow(/OPTIMIZER_SERVICE_URL is not set/);
  });

  it('allows the heuristic engine outside production', () => {
    delete process.env.OPTIMIZER_SERVICE_URL;
    process.env.NODE_ENV = 'development';
    expect(() => assertMilpOptimizerConfigured()).not.toThrow();
    expect(isMilpOptimizerConfigured()).toBe(false);
  });
});

describe('solveMilpDispatch', () => {
  it('rejects a non-optimal solve instead of returning its empty schedule', async () => {
    process.env.OPTIMIZER_SERVICE_URL = 'http://optimizer:8000';
    stubFetch(
      jsonResponse({
        status: 'not_solved',
        solver: 'HiGHS',
        objective: 'minimize_cost',
        interval_minutes: 60,
        horizon: 1,
        totals: {},
        intervals: [],
        diagnostics: {},
      })
    );

    await expect(solveMilpDispatch(REQUEST)).rejects.toThrow(/status not_solved/);
  });

  it('surfaces the solver status from an error response', async () => {
    process.env.OPTIMIZER_SERVICE_URL = 'http://optimizer:8000';
    stubFetch(jsonResponse({ detail: { status: 'infeasible' } }, 422));

    const error = await solveMilpDispatch(REQUEST).catch(e => e);
    expect(error).toBeInstanceOf(MilpOptimizerError);
    expect((error as MilpOptimizerError).statusCode).toBe(422);
    expect((error as MilpOptimizerError).solveStatus).toBe('infeasible');
  });

  it('reports an unreachable optimizer rather than degrading silently', async () => {
    process.env.OPTIMIZER_SERVICE_URL = 'http://optimizer:8000';
    stubFetch(new TypeError('fetch failed'));

    await expect(solveMilpDispatch(REQUEST)).rejects.toThrow(/unreachable/);
  });

  it('sends the shared token and returns an optimal schedule', async () => {
    process.env.OPTIMIZER_SERVICE_URL = 'http://optimizer:8000/';
    process.env.OPTIMIZER_AUTH_TOKEN = 'tok';
    const fetchMock = stubFetch(
      jsonResponse({
        status: 'optimal',
        solver: 'HiGHS',
        objective: 'minimize_cost',
        interval_minutes: 60,
        horizon: 1,
        totals: { objective_value_cents: 10 },
        intervals: [
          {
            index: 0,
            offset_minutes: 0,
            grid_import_w: 1000,
            grid_export_w: 0,
            unserved_load_w: 0,
            setpoints: [],
          },
        ],
        diagnostics: {},
      })
    );

    const result = await solveMilpDispatch(REQUEST);
    expect(result.status).toBe('optimal');
    expect(result.intervals).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://optimizer:8000/optimize/dispatch');
    expect((init.headers as Record<string, string>)['x-optimizer-token']).toBe('tok');
  });

  it('requires the service URL', async () => {
    delete process.env.OPTIMIZER_SERVICE_URL;
    await expect(solveMilpDispatch(REQUEST)).rejects.toThrow(/OPTIMIZER_SERVICE_URL/);
  });
});
