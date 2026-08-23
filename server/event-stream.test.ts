/**
 * The event stream's two promises, pinned.
 *
 * Producing: an event is recorded in the same transaction as the fact it
 * describes, and is only marked published once the broker has acknowledged it.
 * Consuming: the same event delivered twice is applied once, and a message that
 * cannot be read is kept as a dead letter rather than dropped.
 *
 * The behavioural half of this file needs a real PostgreSQL, because the
 * properties being claimed are PostgreSQL's: `ON CONFLICT DO NOTHING` for
 * identity, `FOR UPDATE SKIP LOCKED` for two relays claiming disjoint work, and
 * transaction rollback taking the event with it. Faking those would prove the
 * fake. Without `DATABASE_URL` that half is skipped rather than replaced by
 * something weaker.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from './db';
import {
  EVENT_SCHEMA_VERSION,
  MAX_PUBLISH_ATTEMPTS,
  backoffMsFor,
  brokerConfigured,
  enqueueEvent,
  envelope,
  listOpenDeadLetters,
  listUndeliverable,
  outboxHealth,
  relayOutboxBatch,
  requeueUndeliverable,
  type PublishFn,
} from './services/events/outbox';
import {
  configuredTopics,
  consumerStatus,
  identityFor,
  nextOffsets,
  inboxHealth,
  storeBatch,
} from './services/events/consumer';

const savedBrokers = process.env.KAFKA_BROKERS;
const savedTopics = process.env.EVENT_CONSUMER_TOPICS;

afterEach(() => {
  if (savedBrokers === undefined) delete process.env.KAFKA_BROKERS;
  else process.env.KAFKA_BROKERS = savedBrokers;
  if (savedTopics === undefined) delete process.env.EVENT_CONSUMER_TOPICS;
  else process.env.EVENT_CONSUMER_TOPICS = savedTopics;
});

describe('the event envelope', () => {
  it('stamps the contract onto every payload so a consumer can refuse a version it does not know', () => {
    const stamped = envelope({
      topic: 'payments.completed',
      eventKey: 'payment.completed:abc',
      payload: { paymentId: 'abc', amount: 1500 },
    });
    expect(stamped).toMatchObject({
      paymentId: 'abc',
      amount: 1500,
      event_key: 'payment.completed:abc',
      schema: 'payments.completed',
      schema_version: EVENT_SCHEMA_VERSION,
    });
  });

  it('carries a caller-declared version instead of asserting the current one', () => {
    const stamped = envelope({
      topic: 'trades.settled',
      eventKey: 'trades.settled:7',
      schemaVersion: 3,
      payload: {},
    });
    expect(stamped.schema_version).toBe(3);
  });
});

describe('retry pacing', () => {
  it('backs off steeply and then stops growing, so a long broker outage is retried without a thundering herd', () => {
    expect(backoffMsFor(1)).toBe(2_000);
    expect(backoffMsFor(2)).toBe(8_000);
    expect(backoffMsFor(3)).toBe(32_000);
    expect(backoffMsFor(20)).toBe(15 * 60_000);
  });
});

describe('a deployment with no broker', () => {
  it('is reported as having no stream rather than as a healthy one', () => {
    delete process.env.KAFKA_BROKERS;
    expect(brokerConfigured()).toBe(false);
    const status = consumerStatus();
    expect(status.configured).toBe(false);
    expect(status.detail).toMatch(/no events are consumed anywhere/);
  });

  it('says out loud when events are published that nothing reads back', () => {
    process.env.KAFKA_BROKERS = 'localhost:9092';
    process.env.EVENT_CONSUMER_TOPICS = '';
    expect(configuredTopics()).toEqual([]);
    expect(consumerStatus().detail).toMatch(/nothing in it reads back/);
  });
});

describe('consumed event identity', () => {
  const base = { key: null, value: '{}', offset: '42' };

  it('prefers the producer-declared key, so a re-published event is recognised as the same event', () => {
    expect(
      identityFor('trades.created', 3, { ...base, headers: { 'event-key': 'trades.created:9' } })
    ).toBe('trades.created:9');
  });

  it('falls back to the event id inside the payload for producers that set no header', () => {
    expect(identityFor('payments.initiated', 0, { ...base, value: '{"event_id":"pay-1"}' })).toBe(
      'pay-1'
    );
  });

  it('uses the message coordinates for a foreign producer that declares no identity at all', () => {
    expect(identityFor('foreign.topic', 2, { ...base, key: 'k' })).toBe('k:2:42');
    expect(identityFor('foreign.topic', 2, base)).toBe('foreign.topic:2:42');
  });
});

describe('offset commits', () => {
  it('commits the offset after the batch, so a restarted consumer reads on rather than re-reading', () => {
    expect(nextOffsets('trades.created', 2, '41')).toEqual({
      topics: [{ topic: 'trades.created', partitions: [{ partition: 2, offset: '42' }] }],
    });
  });

  it('keeps offsets exact past 2^53, where a busy topic leaves floating point behind', () => {
    expect(nextOffsets('telemetry', 0, '9007199254740993').topics[0].partitions[0].offset).toBe(
      '9007199254740994'
    );
  });
});

const dbUrl = process.env.DATABASE_URL;

describe.skipIf(!dbUrl)('against a real PostgreSQL', () => {
  let database: NonNullable<Awaited<ReturnType<typeof getDb>>>;

  beforeAll(async () => {
    const resolved = await getDb();
    if (!resolved) throw new Error('DATABASE_URL is set but no connection could be made');
    database = resolved;
  });

  beforeEach(async () => {
    await database.execute(sql`DELETE FROM event_dead_letters`);
    await database.execute(sql`DELETE FROM event_outbox`);
    await database.execute(sql`DELETE FROM event_inbox`);
    process.env.KAFKA_BROKERS = 'localhost:9092';
  });

  const accepting: PublishFn = async () => {};
  const refusing: PublishFn = async () => {
    throw new Error('broker refused: UNKNOWN_TOPIC_OR_PARTITION');
  };

  it('takes the event with it when the business transaction rolls back', async () => {
    await expect(
      database.transaction(async tx => {
        await enqueueEvent(tx as never, {
          topic: 'trades.created',
          eventKey: 'rolled-back',
          payload: { tradeId: '1' },
        });
        throw new Error('the business write failed after the event was recorded');
      })
    ).rejects.toThrow(/business write failed/);

    const rows = await database.execute(sql`SELECT id FROM event_outbox WHERE event_key = 'rolled-back'`);
    expect(rows.rows).toHaveLength(0);
  });

  it('records the same event once, so a replayed callback publishes once', async () => {
    const first = await enqueueEvent(database as never, {
      topic: 'payments.completed',
      eventKey: 'payment.completed:tx-1',
      payload: { paymentId: 'tx-1' },
    });
    const second = await enqueueEvent(database as never, {
      topic: 'payments.completed',
      eventKey: 'payment.completed:tx-1',
      payload: { paymentId: 'tx-1' },
    });
    expect([first, second]).toEqual([true, false]);
    const rows = await database.execute(sql`SELECT id FROM event_outbox`);
    expect(rows.rows).toHaveLength(1);
  });

  it('publishes nothing and holds the event when no broker is configured', async () => {
    delete process.env.KAFKA_BROKERS;
    await enqueueEvent(database as never, {
      topic: 'settlement.events',
      eventKey: 'settlement:1',
      payload: {},
    });

    const result = await relayOutboxBatch(10, accepting);
    expect(result).toMatchObject({ claimed: 0, published: 0 });
    expect(result.skippedReason).toMatch(/KAFKA_BROKERS is not set/);

    const health = await outboxHealth();
    expect(health.pending).toBe(1);
    expect(health.detail).toMatch(/No broker is configured/);
  });

  it('marks an event published only after the broker acknowledged it', async () => {
    await enqueueEvent(database as never, {
      topic: 'settlement.events',
      eventKey: 'settlement:2',
      payload: { settlementId: '2' },
    });

    const seen: Array<{ topic: string; stateAtPublishTime: string }> = [];
    const observing: PublishFn = async topic => {
      const rows = await database.execute<Record<string, unknown>>(
        sql`SELECT state FROM event_outbox WHERE event_key = 'settlement:2'`
      );
      seen.push({ topic, stateAtPublishTime: String(rows.rows[0]?.state) });
    };

    const result = await relayOutboxBatch(10, observing);
    expect(result).toMatchObject({ claimed: 1, published: 1, retryable: 0, undeliverable: 0 });
    // The row was still pending while the broker was being asked: nothing is
    // marked delivered in the hope that it will be.
    expect(seen).toEqual([{ topic: 'settlement.events', stateAtPublishTime: 'pending' }]);

    const after = await database.execute<Record<string, unknown>>(
      sql`SELECT state, published_at, attempts FROM event_outbox WHERE event_key = 'settlement:2'`
    );
    expect(after.rows[0]).toMatchObject({ state: 'published', attempts: 1 });
    expect(after.rows[0].published_at).not.toBeNull();
  });

  it('holds a refused event as pending with the broker error, and retries it later', async () => {
    await enqueueEvent(database as never, {
      topic: 'trades.settled',
      eventKey: 'trades.settled:5',
      payload: {},
    });

    const result = await relayOutboxBatch(10, refusing);
    expect(result).toMatchObject({ claimed: 1, published: 0, retryable: 1, undeliverable: 0 });

    const row = await database.execute<Record<string, unknown>>(sql`
      SELECT state, attempts, last_error, next_attempt_at > NOW() AS deferred
      FROM event_outbox WHERE event_key = 'trades.settled:5'
    `);
    expect(row.rows[0]).toMatchObject({ state: 'pending', attempts: 1, deferred: true });
    expect(String(row.rows[0].last_error)).toMatch(/UNKNOWN_TOPIC_OR_PARTITION/);

    // Not due yet, so a second pass leaves it alone instead of hammering the broker.
    expect(await relayOutboxBatch(10, refusing)).toMatchObject({ claimed: 0 });
  });

  it('gives up into a visible undeliverable state and a dead letter, never into silence', async () => {
    await enqueueEvent(database as never, {
      topic: 'trades.settled',
      eventKey: 'trades.settled:6',
      payload: {},
    });
    await database.execute(sql`
      UPDATE event_outbox SET attempts = ${MAX_PUBLISH_ATTEMPTS - 1}
      WHERE event_key = 'trades.settled:6'
    `);

    const result = await relayOutboxBatch(10, refusing);
    expect(result).toMatchObject({ undeliverable: 1, published: 0 });

    const held = await listUndeliverable();
    expect(held).toHaveLength(1);
    expect(held[0].eventKey).toBe('trades.settled:6');
    // The payload is still there: the event is held for a human, not discarded.
    expect(held[0].payload).toBeTruthy();

    const deadLetters = await listOpenDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].side).toBe('produce');
    expect(deadLetters[0].reason).toMatch(new RegExp(`after ${MAX_PUBLISH_ATTEMPTS} attempts`));

    const health = await outboxHealth();
    expect(health.undeliverable).toBe(1);
    expect(health.detail).toMatch(/need an operator; they are kept, not dropped/);

    // Requeued after the cause is fixed, the same event publishes normally.
    expect(await requeueUndeliverable()).toEqual({ requeued: 1 });
    expect(await relayOutboxBatch(10, accepting)).toMatchObject({ published: 1 });
  });

  it('lets two relays run at once without either publishing the other`s event', async () => {
    for (let index = 0; index < 6; index += 1) {
      await enqueueEvent(database as never, {
        topic: 'settlement.events',
        eventKey: `concurrent:${index}`,
        payload: { index },
      });
    }

    const publishedBy = new Map<string, string[]>();
    const relay = (name: string): PublishFn =>
      async (_topic, message) => {
        publishedBy.set(name, [...(publishedBy.get(name) ?? []), message.key]);
        await new Promise(resolve => setTimeout(resolve, 10));
      };

    const [left, right] = await Promise.all([
      relayOutboxBatch(6, relay('left')),
      relayOutboxBatch(6, relay('right')),
    ]);

    expect(left.published + right.published).toBe(6);
    const keys = [...(publishedBy.get('left') ?? []), ...(publishedBy.get('right') ?? [])];
    expect(new Set(keys).size).toBe(keys.length);

    const remaining = await database.execute(sql`SELECT id FROM event_outbox WHERE state <> 'published'`);
    expect(remaining.rows).toHaveLength(0);
  });

  it('applies a duplicate delivery once', async () => {
    const message = {
      key: 'settlement:9',
      value: JSON.stringify({ event_id: 'settlement:9', amount: 100 }),
      offset: '11',
      timestamp: String(Date.now()),
      headers: { 'event-key': 'settlement:9' },
    };

    expect(await storeBatch('settlement.events', 0, [message])).toMatchObject({
      stored: 1,
      duplicates: 0,
    });
    // Same event, redelivered after a rebalance at a different offset.
    expect(await storeBatch('settlement.events', 0, [{ ...message, offset: '12' }])).toMatchObject({
      stored: 0,
      duplicates: 1,
    });

    const rows = await database.execute(sql`SELECT id FROM event_inbox WHERE event_key = 'settlement:9'`);
    expect(rows.rows).toHaveLength(1);
  });

  it('keeps an unreadable message as a dead letter instead of dropping it', async () => {
    const result = await storeBatch('trades.created', 1, [
      { key: 'x', value: 'not json at all', offset: '3', headers: { 'event-key': 'broken:1' } },
    ]);
    expect(result).toMatchObject({ stored: 0, deadLettered: 1 });

    const deadLetters = await listOpenDeadLetters();
    expect(deadLetters[0]).toMatchObject({ side: 'consume', topic: 'trades.created' });
    expect(deadLetters[0].reason).toMatch(/could not be read/);
  });

  it('reports a configured topic with no consumed events as exactly that', async () => {
    process.env.EVENT_CONSUMER_TOPICS = 'settlement.events,trades.created';
    await storeBatch('settlement.events', 0, [
      {
        key: null,
        value: JSON.stringify({ event_id: 'settlement:20' }),
        offset: '1',
        timestamp: String(Date.now() - 4_000),
      },
    ]);

    const health = await inboxHealth();
    expect(health.topics.map(topic => topic.topic)).toEqual(['settlement.events']);
    expect(health.topics[0].consumed).toBe(1);
    expect(health.topics[0].medianLagSeconds).toBeGreaterThanOrEqual(3);
    expect(health.configuredWithNoEvents).toEqual(['trades.created']);
  });
});
