/**
 * The network feasibility boundary must never turn an unanswered question into
 * a network-approved one:
 *  - an unset service URL, an HTTP error, a timeout and an unreachable host all
 *    come back `service_unavailable` with the study recorded, not thrown away
 *  - a study is only `feasible` when the solver said so
 *  - the element named in a refusal is the one furthest past its own limit
 *  - the candidate a flexibility award represents has the sign of its direction
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  SCALES,
  getGridModelServiceUrl,
  isNetworkFeasibilityConfigured,
  limitingElementOf,
  studyFeasibility,
  worstViolation,
  type FeasibilityViolation,
} from './services/network-feasibility';
import { awardCandidateDeltaW } from './services/locational-flexibility';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function violation(
  element: string,
  value: number,
  limit: number,
  kind: FeasibilityViolation['kind'] = 'transformer_loading'
): FeasibilityViolation {
  return { kind, element, value, limit, candidate_references: [] };
}

describe('service configuration', () => {
  it('reports no service rather than defaulting to a URL', () => {
    delete process.env.GRIDMODEL_SERVICE_URL;
    expect(getGridModelServiceUrl()).toBeUndefined();
    expect(isNetworkFeasibilityConfigured()).toBe(false);
  });

  it('trims a trailing slash so the path is not doubled', () => {
    process.env.GRIDMODEL_SERVICE_URL = 'http://gridmodel:8100/';
    expect(getGridModelServiceUrl()).toBe('http://gridmodel:8100');
    expect(isNetworkFeasibilityConfigured()).toBe(true);
  });

  it('treats whitespace as unset', () => {
    process.env.GRIDMODEL_SERVICE_URL = '   ';
    expect(isNetworkFeasibilityConfigured()).toBe(false);
  });
});

describe('worstViolation', () => {
  it('ranks by relative excess, not by the units the limits happen to use', () => {
    // 1.07 pu against a 1.05 band is ~1.9% over; 104% against 100% is 4% over.
    const worst = worstViolation([
      violation('bus LV-3', 1.07, 1.05, 'bus_overvoltage'),
      violation('transformer TX1', 104, 100),
    ]);
    expect(worst?.element).toBe('transformer TX1');
  });

  it('names nothing when nothing is violated', () => {
    expect(worstViolation([])).toBeNull();
    expect(limitingElementOf([])).toBeNull();
  });

  it('names the element a refusal has to cite', () => {
    expect(
      limitingElementOf([violation('line L1', 101, 100), violation('transformer TX1', 180, 100)])
    ).toBe('transformer TX1');
  });

  it('does not divide by a zero limit', () => {
    const worst = worstViolation([violation('transformer TX0', 5, 0)]);
    expect(worst?.element).toBe('transformer TX0');
  });
});

describe('awardCandidateDeltaW', () => {
  it('raises net injection when import is reduced', () => {
    expect(awardCandidateDeltaW('import_reduction', 4000)).toBe(4000);
  });

  it('lowers net injection when export is reduced', () => {
    expect(awardCandidateDeltaW('export_reduction', 4000)).toBe(-4000);
  });
});

describe('studyFeasibility without a database', () => {
  // With no DATABASE_URL there is no electrical model to load, which is exactly
  // the state a deployment that has never surveyed its network is in. It must
  // read as unavailable, and it must never read as feasible.
  it('reports the model as unavailable rather than assuming a network', async () => {
    delete process.env.GRIDMODEL_SERVICE_URL;
    const study = await studyFeasibility({ subject: 'dispatch', nodeId: 1 });
    expect(study.status).toBe('model_unavailable');
    expect(study.violations).toEqual([]);
    expect(study.limitingElement).toBeNull();
    expect(study.reason).toMatch(/database|does not exist/i);
  });

  it('never returns feasible when it could not ask anything', async () => {
    process.env.GRIDMODEL_SERVICE_URL = 'http://gridmodel:8100';
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const study = await studyFeasibility({ subject: 'flexibility_clearing', nodeId: 99 });
    expect(study.status).not.toBe('feasible');
    // No model means no request: the solver is not asked to invent a network.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('engineering unit scales', () => {
  // These constants convert the integer columns the platform stores into the
  // units the solver takes. A wrong factor here silently mis-sizes a feeder, so
  // they are pinned rather than trusted to review.
  it('are the factors the schema comments claim', () => {
    expect(SCALES.voltsToKv).toBe(1_000);
    expect(SCALES.puX1000).toBe(1_000);
    expect(SCALES.metresToKm).toBe(1_000);
    expect(SCALES.milliohmsToOhms).toBe(1_000);
    expect(SCALES.milliampsToKiloamps).toBe(1_000_000);
    expect(SCALES.kvaToMva).toBe(1_000);
    expect(SCALES.percentX100).toBe(100);
  });
});
