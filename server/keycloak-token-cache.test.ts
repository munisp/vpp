import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { cacheTtlSeconds, isExpired, tokenCacheKey } from './integration/keycloak-auth';

const SECOND = 1000;

describe('keycloak token cache', () => {
  it('never uses the bearer token itself as a cache key', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.header.signature';
    const key = tokenCacheKey(token);
    expect(key).not.toContain(token);
    expect(key).toBe(
      `keycloak:token:${createHash('sha256').update(token).digest('hex')}`
    );
  });

  it('gives the same token the same key, so a session is reused not duplicated', () => {
    expect(tokenCacheKey('abc')).toBe(tokenCacheKey('abc'));
    expect(tokenCacheKey('abc')).not.toBe(tokenCacheKey('abd'));
  });

  it('caches for the token\'s remaining life when that is shorter than the ceiling', () => {
    const now = 1_700_000_000_000;
    const exp = now / SECOND + 30;
    // 30s of life, less the 5s safety margin.
    expect(cacheTtlSeconds(exp, now)).toBe(25);
  });

  it('caps the cache at five minutes even for a long-lived token', () => {
    const now = 1_700_000_000_000;
    const exp = now / SECOND + 86_400;
    expect(cacheTtlSeconds(exp, now)).toBe(300);
  });

  it('will not cache a token that expires inside the safety margin', () => {
    const now = 1_700_000_000_000;
    expect(cacheTtlSeconds(now / SECOND + 3, now)).toBe(0);
    expect(cacheTtlSeconds(now / SECOND, now)).toBe(0);
  });

  it('never returns a negative ttl for an already expired token', () => {
    const now = 1_700_000_000_000;
    expect(cacheTtlSeconds(now / SECOND - 600, now)).toBe(0);
  });

  it('treats a token with no declared expiry as cacheable for the ceiling only', () => {
    expect(cacheTtlSeconds(null, 1_700_000_000_000)).toBe(300);
  });

  it('calls an expired token expired', () => {
    const now = 1_700_000_000_000;
    expect(isExpired(now / SECOND - 1, now)).toBe(true);
    expect(isExpired(now / SECOND, now)).toBe(true);
  });

  it('does not call a live token expired', () => {
    const now = 1_700_000_000_000;
    expect(isExpired(now / SECOND + 1, now)).toBe(false);
  });

  it('does not invent an expiry for a token that declared none', () => {
    expect(isExpired(null, 1_700_000_000_000)).toBe(false);
  });
});
