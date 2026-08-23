import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import {
  RedisRateLimitStore,
  SharedCounterUnavailableError,
  createRateLimitStore,
  sharedCountersConfigured,
  assertSharedCountersAvailable,
} from './services/rate-limit-store';

/**
 * A Redis stand-in that keeps counters in a map, so a single store instance can
 * be shared the way two replicas share one Redis.
 */
function fakeRedis(state: {
  counters: Map<string, { value: number; expiresAt: number | null }>;
  fail?: boolean;
}) {
  const now = () => Date.now();
  const live = (key: string) => {
    const entry = state.counters.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      state.counters.delete(key);
      return undefined;
    }
    return entry;
  };
  const guard = () => {
    if (state.fail) throw new Error('redis is down');
  };
  const client = {
    multi() {
      const ops: Array<() => [Error | null, unknown]> = [];
      const chain = {
        incr(key: string) {
          ops.push(() => {
            const entry = live(key);
            if (!entry) {
              state.counters.set(key, { value: 1, expiresAt: null });
              return [null, 1];
            }
            entry.value += 1;
            return [null, entry.value];
          });
          return chain;
        },
        pttl(key: string) {
          ops.push(() => {
            const entry = live(key);
            if (!entry) return [null, -2];
            if (entry.expiresAt === null) return [null, -1];
            return [null, entry.expiresAt - now()];
          });
          return chain;
        },
        async exec() {
          guard();
          return ops.map(op => op());
        },
      };
      return chain;
    },
    async pexpire(key: string, ms: number) {
      guard();
      const entry = state.counters.get(key);
      if (entry) entry.expiresAt = now() + ms;
      return 1;
    },
    async get(key: string) {
      guard();
      const entry = live(key);
      return entry ? String(entry.value) : null;
    },
    async pttl(key: string) {
      guard();
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === null ? -1 : entry.expiresAt - now();
    },
    async eval(_script: string, _numKeys: number, key: string) {
      guard();
      const entry = live(key);
      if (!entry) return -1;
      entry.value -= 1;
      return entry.value;
    },
    async scan(cursor: string, _match: string, pattern: string) {
      guard();
      const prefix = pattern.replace(/\*$/, '');
      return ['0', [...state.counters.keys()].filter(key => key.startsWith(prefix))] as [
        string,
        string[],
      ];
    },
    async del(...keys: string[]) {
      guard();
      let removed = 0;
      for (const key of keys) if (state.counters.delete(key)) removed += 1;
      return removed;
    },
    async keys(pattern: string) {
      guard();
      const prefix = pattern.replace(/\*$/, '');
      return [...state.counters.keys()].filter(key => key.startsWith(prefix));
    },
    async quit() {
      return 'OK';
    },
  };
  return client as unknown as Redis;
}

describe('shared rate-limit counters', () => {
  it('counts hits from separate replicas against one limit', async () => {
    const state = { counters: new Map() };
    const replicaA = new RedisRateLimitStore({
      limiter: 'payments',
      windowMs: 60_000,
      onRedisFailure: 'refuse',
      client: fakeRedis(state),
    });
    const replicaB = new RedisRateLimitStore({
      limiter: 'payments',
      windowMs: 60_000,
      onRedisFailure: 'refuse',
      client: fakeRedis(state),
    });

    await replicaA.increment('1.2.3.4');
    await replicaA.increment('1.2.3.4');
    const third = await replicaB.increment('1.2.3.4');

    // In-process counters would have reported 1 here, which is how a limit of
    // 30 becomes 30 per replica.
    expect(third.totalHits).toBe(3);
  });

  it('declares that its keys are not local, so double counting can be detected', () => {
    const store = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 1000,
      onRedisFailure: 'count_locally',
      client: fakeRedis({ counters: new Map() }),
    });
    expect(store.localKeys).toBe(false);
    expect(store.prefix).toBe('ratelimit:api:');
  });

  it('sets the window expiry once instead of sliding it forward on every hit', async () => {
    const state = { counters: new Map() };
    const store = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 60_000,
      onRedisFailure: 'count_locally',
      client: fakeRedis(state),
    });

    const first = await store.increment('ip');
    const firstReset = first.resetTime!.getTime();
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await store.increment('ip');

    expect(second.totalHits).toBe(2);
    // The window still ends when the first hit said it would.
    expect(second.resetTime!.getTime()).toBeLessThanOrEqual(firstReset);
  });

  it('separates the counters of different limiters', async () => {
    const state = { counters: new Map() };
    const payments = new RedisRateLimitStore({
      limiter: 'payments',
      windowMs: 60_000,
      onRedisFailure: 'refuse',
      client: fakeRedis(state),
    });
    const api = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 60_000,
      onRedisFailure: 'count_locally',
      client: fakeRedis(state),
    });

    await payments.increment('ip');
    const apiHit = await api.increment('ip');
    expect(apiHit.totalHits).toBe(1);
  });

  it('refuses a money request it cannot meter rather than admitting it', async () => {
    const store = new RedisRateLimitStore({
      limiter: 'payments',
      windowMs: 60_000,
      onRedisFailure: 'refuse',
      client: fakeRedis({ counters: new Map(), fail: true }),
    });

    await expect(store.increment('ip')).rejects.toBeInstanceOf(
      SharedCounterUnavailableError
    );
  });

  it('keeps counting per replica, loudly, when the general API loses Redis', async () => {
    const state = { counters: new Map(), fail: true };
    const store = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 60_000,
      onRedisFailure: 'count_locally',
      client: fakeRedis(state),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await store.increment('ip');
    const second = await store.increment('ip');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0][0])).toContain('per-replica');
    logged.mockRestore();
  });

  it('resumes shared counting when Redis comes back', async () => {
    const state: { counters: Map<string, { value: number; expiresAt: number | null }>; fail?: boolean } =
      { counters: new Map(), fail: true };
    const store = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 60_000,
      onRedisFailure: 'count_locally',
      client: fakeRedis(state),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await store.increment('ip');
    state.fail = false;
    const shared = await store.increment('ip');

    // The shared counter starts from what Redis holds, not from the local count.
    expect(shared.totalHits).toBe(1);
    logged.mockRestore();
  });

  it('reports an unreadable money counter as unavailable, not as zero hits', async () => {
    const store = new RedisRateLimitStore({
      limiter: 'payments',
      windowMs: 60_000,
      onRedisFailure: 'refuse',
      client: fakeRedis({ counters: new Map(), fail: true }),
    });
    await expect(store.get('ip')).rejects.toBeInstanceOf(SharedCounterUnavailableError);
  });

  it('names the limiter that could not be metered', async () => {
    const store = new RedisRateLimitStore({
      limiter: 'payments',
      windowMs: 60_000,
      onRedisFailure: 'refuse',
      client: fakeRedis({ counters: new Map(), fail: true }),
    });
    const error = await store.increment('ip').catch(caught => caught);
    expect(error.code).toBe('RATE_LIMIT_COUNTER_UNAVAILABLE');
    expect(error.message).toContain('payments');
  });

  it('does not create a counter out of a decrement for a client with no window', async () => {
    const state = { counters: new Map<string, { value: number; expiresAt: number | null }>() };
    const store = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 60_000,
      onRedisFailure: 'count_locally',
      client: fakeRedis(state),
    });
    await store.decrement('never-seen');
    // A key created at -1 with no expiry would sit in Redis forever.
    expect(state.counters.has('ratelimit:api:never-seen')).toBe(false);
  });

  it('releases a hit without dropping the client below zero', async () => {
    const state = { counters: new Map<string, { value: number; expiresAt: number | null }>() };
    const store = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 60_000,
      onRedisFailure: 'count_locally',
      client: fakeRedis(state),
    });
    await store.increment('ip');
    await store.increment('ip');
    await store.decrement('ip');
    expect((await store.get('ip'))!.totalHits).toBe(1);
    await store.decrement('ip');
    expect(await store.get('ip')).toBeUndefined();
  });

  it('clears every counter of one limiter without scanning the whole keyspace', async () => {
    const state = { counters: new Map<string, { value: number; expiresAt: number | null }>() };
    const api = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 60_000,
      onRedisFailure: 'count_locally',
      client: fakeRedis(state),
    });
    const payments = new RedisRateLimitStore({
      limiter: 'payments',
      windowMs: 60_000,
      onRedisFailure: 'refuse',
      client: fakeRedis(state),
    });
    await api.increment('a');
    await api.increment('b');
    await payments.increment('a');
    await api.resetAll();
    expect(await api.get('a')).toBeUndefined();
    expect((await payments.get('a'))!.totalHits).toBe(1);
  });

  it('clears a key everywhere, not just in this process', async () => {
    const state = { counters: new Map() };
    const store = new RedisRateLimitStore({
      limiter: 'api',
      windowMs: 60_000,
      onRedisFailure: 'count_locally',
      client: fakeRedis(state),
    });
    await store.increment('ip');
    await store.resetKey('ip');
    expect(await store.get('ip')).toBeUndefined();
  });
});

describe('shared counter configuration', () => {
  const env = { ...process.env };

  it('treats a deployment with no Redis as unconfigured, not as working', () => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_URL;
    delete process.env.RATE_LIMIT_STORE;
    expect(sharedCountersConfigured()).toBe(false);
    Object.assign(process.env, env);
  });

  it('honours an explicit choice to count in memory', () => {
    process.env.REDIS_HOST = 'localhost';
    process.env.RATE_LIMIT_STORE = 'memory';
    expect(sharedCountersConfigured()).toBe(false);
    Object.assign(process.env, env);
  });

  it('refuses to start a production deployment whose limits would be per-replica', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_URL;
    delete process.env.RATE_LIMIT_STORE;
    expect(() => assertSharedCountersAvailable()).toThrow(/REDIS_HOST/);
    Object.assign(process.env, env);
  });

  it('starts a production deployment that opted into per-replica counting, and says so', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_URL;
    process.env.RATE_LIMIT_STORE = 'memory';
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertSharedCountersAvailable()).not.toThrow();
    expect(String(warned.mock.calls[0][0])).toContain('replica count');
    warned.mockRestore();
    Object.assign(process.env, env);
  });

  it('starts a development deployment without Redis and warns', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_URL;
    delete process.env.RATE_LIMIT_STORE;
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertSharedCountersAvailable()).not.toThrow();
    expect(createRateLimitStore({ limiter: 'api', windowMs: 1000, onRedisFailure: 'count_locally' })).toBeUndefined();
    expect(String(warned.mock.calls[0][0])).toContain('replica count');
    warned.mockRestore();
    Object.assign(process.env, env);
  });
});
