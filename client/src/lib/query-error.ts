/**
 * Operator-facing text for a query that failed.
 *
 * A failed read must always be loud, but it must not be loud in the database's
 * words: a driver error carries the failing statement and its parameters, and
 * printing that into a member-facing page discloses the schema and the shape of
 * every query behind it. So only messages the platform wrote for a human are
 * shown; anything else is reported by its class, with the detail left in the
 * server log where it belongs.
 */
export type MaybeTRPCError = {
  message?: unknown;
  data?: { code?: unknown } | null;
} | null;

/** Codes the platform raises deliberately, with copy meant to be read. */
const CURATED_CODES = new Set([
  'SERVICE_UNAVAILABLE',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'BAD_REQUEST',
  'PRECONDITION_FAILED',
  'TOO_MANY_REQUESTS',
]);

/** Rough shape of a statement leaking through in an error message. */
const STATEMENT_SHAPED = /\b(select|insert into|update|delete from|join|from)\b/i;

export function operatorErrorDetail(error: MaybeTRPCError): string {
  const code = typeof error?.data?.code === 'string' ? error.data.code : null;
  const message = typeof error?.message === 'string' ? error.message.trim() : '';

  if (code && CURATED_CODES.has(code) && message && !STATEMENT_SHAPED.test(message)) {
    return message;
  }

  if (code === 'TIMEOUT') {
    return 'The read timed out. Whether the underlying query completed is unknown.';
  }

  return 'The server could not complete this read. The failure is recorded in the server log; it is deliberately not repeated here, because a driver error carries the query and its parameters.';
}
