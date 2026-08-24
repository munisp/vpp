import { describe, it, expect } from 'vitest';
import { assertPostgresUrl, DatabaseUrlError } from './_core/database-url';

describe('assertPostgresUrl', () => {
  it('accepts the two PostgreSQL schemes', () => {
    for (const url of [
      'postgres://vpp:vpp@127.0.0.1:5432/vpp',
      'postgresql://vpp@db.internal/vpp?sslmode=require',
      'POSTGRES://vpp@127.0.0.1/vpp',
    ]) {
      expect(assertPostgresUrl(url)).toBe(url);
    }
  });

  it('refuses a DSN for another database rather than letting pg fail per query', () => {
    // `pg` accepts this URL and every statement then fails opaquely, which
    // reads as a database outage instead of the misconfiguration it is.
    expect(() => assertPostgresUrl('mysql://vpp:vpp@127.0.0.1:3306/vpp')).toThrow(DatabaseUrlError);
    expect(() => assertPostgresUrl('mysql://vpp:vpp@127.0.0.1:3306/vpp')).toThrow(/only in PostgreSQL/);
    expect(() => assertPostgresUrl('mongodb://127.0.0.1/vpp')).toThrow(/mongodb/);
  });

  it('names the variable it was given', () => {
    expect(() => assertPostgresUrl('mysql://host/db', 'ML_DATABASE_URL')).toThrow(/ML_DATABASE_URL/);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertPostgresUrl('vpp:vpp@127.0.0.1:5432/vpp')).toThrow(DatabaseUrlError);
    expect(() => assertPostgresUrl('/var/run/postgresql')).toThrow(/not a valid URL/);
  });
});
