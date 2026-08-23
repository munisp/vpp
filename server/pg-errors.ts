/**
 * Drizzle does not rethrow the node-postgres error: it throws a plain Error
 * whose message is `Failed query: <sql>` and hangs the driver error, which is
 * where SQLSTATE lives, off `cause`. Callers that key on a constraint (unique
 * reservations, ledger chain appends) must therefore walk the chain instead of
 * reading `error.code`.
 */
export function hasPgErrorCode(error: unknown, code: string): boolean {
  for (let current: unknown = error, depth = 0; current !== null && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false;
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause ?? null;
  }
  return false;
}

/** SQLSTATE 23505: unique constraint or unique index violation. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return hasPgErrorCode(error, PG_UNIQUE_VIOLATION);
}
