import { describe, expect, it } from 'vitest';

import { operatorErrorDetail } from './query-error';

describe('operatorErrorDetail', () => {
  it('shows a refusal the platform wrote for a human', () => {
    const detail = operatorErrorDetail({
      message: 'The database is unavailable, so no twin can be built.',
      data: { code: 'SERVICE_UNAVAILABLE' },
    });

    expect(detail).toBe('The database is unavailable, so no twin can be built.');
  });

  it('never prints a failing statement into the page', () => {
    const detail = operatorErrorDetail({
      message:
        'error: column "observation" does not exist\nquery: SELECT d.id FROM dependency_observations d WHERE d."userId" = $1\nparams: 13',
      data: { code: 'INTERNAL_SERVER_ERROR' },
    });

    expect(detail).not.toContain('SELECT');
    expect(detail).not.toContain('dependency_observations');
    expect(detail).toContain('server log');
  });

  it('withholds a statement even when the code is one the platform raises itself', () => {
    const detail = operatorErrorDetail({
      message: 'failed query: select * from assets a left join lateral (...) t on true',
      data: { code: 'SERVICE_UNAVAILABLE' },
    });

    expect(detail).not.toContain('assets');
  });

  it('says a timeout leaves the outcome unknown', () => {
    expect(operatorErrorDetail({ message: 'timed out', data: { code: 'TIMEOUT' } })).toContain(
      'unknown'
    );
  });

  it('handles an error with no shape at all', () => {
    expect(operatorErrorDetail(null)).toContain('could not complete');
  });
});
