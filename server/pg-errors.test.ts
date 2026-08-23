/**
 * Constraint-keyed recovery (payment reservations, settlement chain appends)
 * only works if the pg SQLSTATE is found where Drizzle actually puts it.
 */
import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './pg-errors';

function driverError(): Error {
  const error = new Error(
    'duplicate key value violates unique constraint "payments_p2p_trade_live_uq"'
  ) as Error & { code: string };
  error.code = '23505';
  return error;
}

describe('isUniqueViolation', () => {
  it('finds the code on the error the driver throws', () => {
    expect(isUniqueViolation(driverError())).toBe(true);
  });

  it('finds the code on the cause Drizzle wraps it in', () => {
    // Drizzle throws `Failed query: ...` with no code of its own, so reading
    // error.code alone reported no conflict and the recovery path never ran.
    expect(
      isUniqueViolation(new Error('Failed query: insert into "payments" ...', { cause: driverError() }))
    ).toBe(true);
  });

  it('finds the code through a nested cause chain', () => {
    const wrapped = new Error('Failed query', { cause: driverError() });
    expect(isUniqueViolation(new Error('outer', { cause: wrapped }))).toBe(true);
  });

  it('does not treat other failures as a unique violation', () => {
    const foreignKey = new Error('violates foreign key constraint') as Error & { code: string };
    foreignKey.code = '23503';
    expect(isUniqueViolation(foreignKey)).toBe(false);
    expect(isUniqueViolation(new Error('socket hang up'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});
