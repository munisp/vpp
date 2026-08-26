/**
 * Shared rate-limit counters.
 *
 * `express-rate-limit`'s default store keeps its counters in the process, so a
 * deployment that runs N replicas behind a load balancer enforces N times the
 * configured limit: the payment limiter of 30 requests per 15 minutes really
 * admits 30 x N. This store keeps the counters in Redis so the limit is the
 * limit however many replicas are running, and — because a counter nobody can
 * read is not a limit — it says out loud what it is doing when Redis is not
 * there rather than quietly reverting to per-replica counting.
 */

import Redis from 'ioredis';
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { redisConfig } from '../integration/redis-cache';

/**
 * What to do with a request when the shared counter cannot be read or written.
 *
 * - `refuse`: fail closed. The request is rejected, because admitting it would
 *   mean admitting an unbounded number of them. Used for money paths, where
 *   an unmetered flood is worse than an outage.
 * - `count_locally`: fall back to a per-process counter and log the downgrade.
 *   The limit becomes per-replica again, which is weaker but bounded; used for
 *   the general API surface, where refusing everything on a Redis outage would
 *   be a self-inflicted denial of service.
 */
export type RedisFailurePolicy = 'refuse' | 'count_locally';

export class SharedCounterUnavailableError extends Error {
  readonly code = 'RATE_LIMIT_COUNTER_UNAVAILABLE';

  constructor(limiter: string, cause: unknown) {
    super(
      `The shared rate-limit counter for ${limiter} is unavailable, so this request cannot be metered: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }
}

/** A per-process window counter, used only as the declared fallback. */
class LocalWindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  increment(key: string, windowMs: number): ClientRateLimitInfo {
    const now = Date.now();
    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.hits.set(key, fresh);
      return { totalHits: 1, resetTime: new Date(fresh.resetAt) };
    }
    existing.count += 1;
    return { totalHits: existing.count, resetTime: new Date(existing.resetAt) };
  }

  get(key: string): ClientRateLimitInfo | undefined {
    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= Date.now()) return undefined;
    return { totalHits: existing.count, resetTime: new Date(existing.resetAt) };
  }

  decrement(key: string): void {
    const existing = this.hits.get(key);
    if (existing && existing.count > 0) existing.count -= 1;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  resetAll(): void {
    this.hits.clear();
  }
}

export interface RedisRateLimitStoreOptions {
  /** Names the limiter in keys and in log lines. */
  limiter: string;
  windowMs: number;
  onRedisFailure: RedisFailurePolicy;
  /** Injected in tests; otherwise a connection is opened from `redisConfig`. */
  client?: Redis;
}

export class RedisRateLimitStore implements Store {
  /** Counters live in Redis, so hits in one replica bind the others. */
  readonly localKeys = false;
  readonly prefix: string;

  private readonly client: Redis;
  private readonly limiter: string;
  private readonly onRedisFailure: RedisFailurePolicy;
  private readonly local = new LocalWindowCounter();
  /**
   * Redis exposes a remaining TTL rather than an absolute expiry timestamp.
   * Keep the first locally observed reset instant for a key so repeat calls on
   * this replica do not make a fixed Redis window appear to slide by one
   * millisecond because Date.now() and PTTL are sampled separately.
   */
  private readonly observedResetAt = new Map<string, number>();
  private windowMs: number;
  private ownsClient: boolean;
  private downgradeLogged = false;

  constructor(options: RedisRateLimitStoreOptions) {
    this.limiter = options.limiter;
    this.windowMs = options.windowMs;
    this.onRedisFailure = options.onRedisFailure;
    this.prefix = `ratelimit:${options.limiter}:`;
    this.ownsClient = !options.client;
    this.client = options.client ?? openCounterConnection();
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private keyFor(key: string): string {
    return `${this.prefix}${key}`;
  }

  private handleFailure(key: string, error: unknown): ClientRateLimitInfo {
    if (this.onRedisFailure === 'refuse') {
      throw new SharedCounterUnavailableError(this.limiter, error);
    }
    if (!this.downgradeLogged) {
      this.downgradeLogged = true;
      console.error(
        `[RateLimit] The shared counter for ${this.limiter} is unavailable; this replica is counting on its own, so the effective limit is per-replica until Redis returns:`,
        error instanceof Error ? error.message : error
      );
    }
    return this.local.increment(key, this.windowMs);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = this.keyFor(key);
    try {
      // INCR then read the remaining TTL, and only set the expiry when the key
      // has none: setting it on every hit would slide the window forward and a
      // steady stream of requests would never reset it.
      const results = await this.client
        .multi()
        .incr(redisKey)
        .pttl(redisKey)
        .exec();
      if (!results) throw new Error('Redis returned no result for the counter');
      const [[incrError, totalHitsRaw], [ttlError, ttlRaw]] = results as [
        [Error | null, unknown],
        [Error | null, unknown],
      ];
      if (incrError) throw incrError;
      if (ttlError) throw ttlError;

      const totalHits = Number(totalHitsRaw);
      let ttl = Number(ttlRaw);
      if (!Number.isFinite(totalHits) || totalHits < 1) {
        throw new Error(`Redis returned a nonsensical hit count: ${totalHitsRaw}`);
      }
      if (ttl < 0) {
        await this.client.pexpire(redisKey, this.windowMs);
        // Read Redis' expiry after setting it. Reconstructing the reset from a
        // later local Date.now() can report a window that moves forward by a
        // millisecond even though Redis correctly kept its original expiry.
        ttl = Number(await this.client.pttl(redisKey));
        if (ttl < 0) throw new Error('Redis did not retain an expiry for the counter');
      }
      this.downgradeLogged = false;
      const estimatedResetAt = Date.now() + ttl;
      const observed = this.observedResetAt.get(redisKey);
      const resetAt = observed && observed > Date.now()
        ? Math.min(observed, estimatedResetAt)
        : estimatedResetAt;
      this.observedResetAt.set(redisKey, resetAt);
      return { totalHits, resetTime: new Date(resetAt) };
    } catch (error) {
      return this.handleFailure(key, error);
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const redisKey = this.keyFor(key);
    try {
      const [countRaw, ttlRaw] = await Promise.all([
        this.client.get(redisKey),
        this.client.pttl(redisKey),
      ]);
      if (countRaw === null) return undefined;
      const ttl = Number(ttlRaw);
      return {
        totalHits: Number(countRaw),
        resetTime: ttl >= 0 ? new Date(Date.now() + ttl) : undefined,
      };
    } catch (error) {
      if (this.onRedisFailure === 'refuse') {
        throw new SharedCounterUnavailableError(this.limiter, error);
      }
      return this.local.get(key);
    }
  }

  async decrement(key: string): Promise<void> {
    const redisKey = this.keyFor(key);
    try {
      // Only an existing counter is decremented: DECR on a missing key would
      // create it at -1 with no expiry, and that key would never age out.
      const remaining = await this.client.eval(
        "if redis.call('exists', KEYS[1]) == 1 then return redis.call('decr', KEYS[1]) else return -1 end",
        1,
        redisKey
      );
      if (Number(remaining) <= 0) await this.client.del(redisKey);
    } catch (error) {
      // A skipped decrement over-counts the client, which is the safe direction.
      console.error(
        `[RateLimit] Could not release a hit for ${this.limiter}:`,
        error instanceof Error ? error.message : error
      );
      this.local.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    this.local.reset(key);
    const redisKey = this.keyFor(key);
    this.observedResetAt.delete(redisKey);
    await this.client.del(redisKey);
  }

  async resetAll(): Promise<void> {
    this.local.resetAll();
    this.observedResetAt.clear();
    // SCAN rather than KEYS: this runs against a shared production Redis, where
    // KEYS blocks the server for the length of the keyspace.
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(
        cursor,
        'MATCH',
        `${this.prefix}*`,
        'COUNT',
        200
      );
      cursor = next;
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  async shutdown(): Promise<void> {
    if (this.ownsClient) {
      await this.client.quit();
    }
  }
}

/**
 * A dedicated connection for counters. `REDIS_URL` is honoured here because the
 * config helper accepts it as evidence that shared counters are configured.
 */
function openCounterConnection(): Redis {
  const url = process.env.REDIS_URL;
  if (url) {
    return new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true });
  }
  return new Redis({ ...redisConfig, lazyConnect: false, keyPrefix: undefined });
}

/**
 * True when this deployment has somewhere to keep shared counters. Absence is
 * configuration, not a failure: a single-process local run does not need Redis.
 */
export function sharedCountersConfigured(): boolean {
  if (process.env.RATE_LIMIT_STORE === 'memory') return false;
  return Boolean(process.env.REDIS_HOST || process.env.REDIS_URL);
}

/**
 * Refuse to boot a production deployment whose rate limits would silently be
 * per-replica. Production runs behind the multi-replica manifests in `k8s/`, so
 * an in-memory limiter there is a limit that does not hold.
 */
export function assertSharedCountersAvailable(): void {
  if (process.env.NODE_ENV !== 'production') return;
  // The opt-out is a decision, not a misconfiguration: it is the one way a
  // production deployment is allowed to count per replica, so it must boot.
  if (process.env.RATE_LIMIT_STORE === 'memory') {
    console.warn(
      '[RateLimit] RATE_LIMIT_STORE=memory in production: counters live in each replica, so every configured limit is multiplied by the replica count.'
    );
    return;
  }
  if (sharedCountersConfigured()) return;
  throw new Error(
    'REDIS_HOST is not set, so rate-limit counters would live in each replica and the configured limits would be multiplied by the replica count. Set REDIS_HOST, or set RATE_LIMIT_STORE=memory to accept per-replica limits deliberately.'
  );
}

/**
 * Build the store for a limiter, or `undefined` to leave `express-rate-limit`
 * on its in-process store when this deployment keeps no shared counters.
 */
export function createRateLimitStore(options: {
  limiter: string;
  windowMs: number;
  onRedisFailure: RedisFailurePolicy;
}): Store | undefined {
  if (!sharedCountersConfigured()) {
    console.warn(
      `[RateLimit] ${options.limiter} is counting in this process only; with more than one replica the effective limit is multiplied by the replica count.`
    );
    return undefined;
  }
  return new RedisRateLimitStore(options);
}
