/**
 * PostgreSQL is the platform's only relational store. Every DSN reaches a
 * `pg` client, which accepts a URL of any scheme and only fails later, one
 * opaque "Failed query" at a time — so a MySQL DSN left in an environment
 * boots a platform that looks healthy and cannot read a row. Refuse it here
 * instead, while the operator is still looking at the log.
 */

const POSTGRES_SCHEMES = ['postgres:', 'postgresql:'];

export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUrlError';
  }
}

/** Returns the DSN unchanged, or throws if it does not address PostgreSQL. */
export function assertPostgresUrl(url: string, variableName = 'DATABASE_URL'): string {
  let scheme: string;
  try {
    scheme = new URL(url).protocol.toLowerCase();
  } catch {
    throw new DatabaseUrlError(`${variableName} is not a valid URL`);
  }
  if (!POSTGRES_SCHEMES.includes(scheme)) {
    throw new DatabaseUrlError(
      `${variableName} addresses ${scheme.replace(':', '')}, and this platform stores its ` +
        'data only in PostgreSQL: use a postgres:// or postgresql:// URL'
    );
  }
  return url;
}
