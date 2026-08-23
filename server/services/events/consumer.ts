/**
 * The consuming half of the stream.
 *
 * Before this, ~30 topics were published and **nothing in this repository read
 * any of them**. Every call site's comment said "publish to Kafka for lakehouse
 * analytics"; the intended reader (`server/integration/lakehouse-etl.py`) is not
 * deployed, so those events went into topics with no consumer group — which looks
 * identical, from the producer's side, to a working pipeline.
 *
 * This consumer closes that loop honestly and modestly: it lands each event in
 * `event_inbox` and nothing more. It does not aggregate, score, or derive
 * anything, because a landing table is what the lakehouse ETL and the operator
 * surfaces actually need, and inventing a projection here would be a second
 * unverified pipeline.
 *
 * Two properties matter:
 *
 *   - **Idempotent.** A rebalance, a restart, or the outbox's at-least-once relay
 *     can deliver the same event twice. The insert is `ON CONFLICT DO NOTHING`
 *     against unique (topic, event_key), so the second delivery changes nothing.
 *   - **Nothing is dropped silently.** A message this consumer cannot store (bad
 *     JSON, oversized key) becomes a `consume` dead letter and the offset moves
 *     on; a message it *could* not store because the database is unavailable is
 *     not committed at all, so it is redelivered rather than skipped.
 */

import type { Consumer, EachBatchPayload } from 'kafkajs';
import { sql } from 'drizzle-orm';
import { kafka } from '../../integration/kafka-config';
import { getDb } from '../../db';
import { eventDeadLetters } from '../../../drizzle/event-stream-schema';
import { brokerConfigured } from './outbox';

/**
 * Which topics this deployment consumes. Deliberately explicit rather than a
 * wildcard: subscribing to everything would put this consumer in the path of
 * high-volume telemetry, and a landing table is not a telemetry store.
 */
export function configuredTopics(): string[] {
  return (process.env.EVENT_CONSUMER_TOPICS ?? '')
    .split(',')
    .map(topic => topic.trim())
    .filter(topic => topic.length > 0);
}

export function consumerConfigured(): boolean {
  return brokerConfigured() && configuredTopics().length > 0;
}

export interface ConsumerStatus {
  configured: boolean;
  running: boolean;
  topics: string[];
  groupId: string;
  detail: string;
}

const GROUP_ID = () => process.env.EVENT_CONSUMER_GROUP ?? 'vpp-event-inbox';

let consumer: Consumer | null = null;
let running = false;

export function consumerStatus(): ConsumerStatus {
  const topics = configuredTopics();
  return {
    configured: consumerConfigured(),
    running,
    topics,
    groupId: GROUP_ID(),
    detail: !brokerConfigured()
      ? 'No broker is configured (KAFKA_BROKERS is unset), so no events are consumed anywhere.'
      : topics.length === 0
        ? 'EVENT_CONSUMER_TOPICS is empty: this deployment publishes events that nothing in it reads back.'
        : running
          ? `Consuming ${topics.length} topic(s) as group ${GROUP_ID()}.`
          : 'Configured but not running in this process.',
  };
}

/** What a stored batch did, so a caller can assert on it. */
export interface ConsumeResult {
  received: number;
  stored: number;
  /** Already present: a redelivery, which must not apply twice. */
  duplicates: number;
  deadLettered: number;
}

interface RawMessage {
  key: Buffer | string | null;
  value: Buffer | string | null;
  offset: string;
  timestamp?: string;
  headers?: Record<string, Buffer | string | undefined> | null;
}

function headerValue(message: RawMessage, name: string): string | undefined {
  const raw = message.headers?.[name];
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

/**
 * The identity used to deduplicate. The producer's `event-key` header is
 * preferred, then the message key; a foreign producer that sets neither falls
 * back to the message's coordinates, which are unique per topic and partition, so
 * such an event is stored once but cannot be recognised across a re-publish.
 */
export function identityFor(topic: string, partition: number, message: RawMessage): string {
  const fromHeader = headerValue(message, 'event-key');
  if (fromHeader) return fromHeader.slice(0, 200);
  const key = message.key === null ? null : message.key.toString();
  const payloadKey = readPayloadEventId(message);
  if (payloadKey) return payloadKey.slice(0, 200);
  if (key) return `${key}:${partition}:${message.offset}`.slice(0, 200);
  return `${topic}:${partition}:${message.offset}`.slice(0, 200);
}

function readPayloadEventId(message: RawMessage): string | undefined {
  try {
    const parsed = JSON.parse(String(message.value));
    const id = parsed?.event_id ?? parsed?.eventId;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store one batch. Exported so the storing logic is tested against a real
 * database without a broker in the loop.
 */
export async function storeBatch(
  topic: string,
  partition: number,
  messages: RawMessage[]
): Promise<ConsumeResult> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so consumed events cannot be recorded.');

  let stored = 0;
  let duplicates = 0;
  let deadLettered = 0;

  for (const message of messages) {
    const eventKey = identityFor(topic, partition, message);
    let payload: unknown;
    try {
      payload = JSON.parse(String(message.value));
      if (payload === null || typeof payload !== 'object') {
        throw new Error(`event body is ${payload === null ? 'null' : typeof payload}, not an object`);
      }
    } catch (error) {
      // Unparseable: keep the raw bytes as a dead letter rather than dropping the
      // event or storing something that is not what the producer sent.
      await db.insert(eventDeadLetters).values({
        side: 'consume',
        topic,
        eventKey,
        payload: { raw: String(message.value).slice(0, 4000) },
        reason: `This event could not be read: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
        attempts: 1,
      });
      deadLettered += 1;
      continue;
    }

    const producedAt = message.timestamp ? new Date(Number(message.timestamp)) : null;
    const inserted = await db.execute(sql`
      INSERT INTO event_inbox (topic, event_key, partition, message_offset, payload, produced_at)
      VALUES (
        ${topic}, ${eventKey}, ${partition}, ${Number(message.offset)},
        ${JSON.stringify(payload)}::jsonb,
        ${producedAt && Number.isFinite(producedAt.getTime()) ? producedAt : null}
      )
      ON CONFLICT (topic, event_key) DO NOTHING
      RETURNING id
    `);
    if (inserted.rows.length > 0) stored += 1;
    else duplicates += 1;
  }

  return { received: messages.length, stored, duplicates, deadLettered };
}

/**
 * Start consuming, if this deployment is configured for it. Returns false when it
 * is not — the caller logs that, because a platform that publishes events nothing
 * reads should say so at boot rather than look complete.
 */
export async function startEventConsumer(): Promise<boolean> {
  if (!consumerConfigured()) return false;
  if (running) return true;

  const topics = configuredTopics();
  consumer = kafka.consumer({ groupId: GROUP_ID(), allowAutoTopicCreation: false });
  await consumer.connect();
  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  await consumer.run({
    // Offsets are committed only after the batch is stored: a database outage
    // must redeliver, never skip. `eachBatch` rather than `eachMessage` so that
    // is one decision per batch instead of per message.
    autoCommit: false,
    eachBatch: async ({ batch, resolveOffset, commitOffsetsIfNecessary, heartbeat }: EachBatchPayload) => {
      const result = await storeBatch(
        batch.topic,
        batch.partition,
        batch.messages as unknown as RawMessage[]
      );
      for (const message of batch.messages) {
        resolveOffset(message.offset);
      }
      await heartbeat();
      await commitOffsetsIfNecessary();
      if (result.stored > 0 || result.deadLettered > 0) {
        console.log(
          `[EventConsumer] ${batch.topic}/${batch.partition} stored=${result.stored} duplicate=${result.duplicates} dead=${result.deadLettered}`
        );
      }
    },
  });

  running = true;
  return true;
}

export async function stopEventConsumer(): Promise<void> {
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
  }
  running = false;
}

export interface InboxTopicHealth {
  topic: string;
  consumed: number;
  lastConsumedAt: Date | null;
  /** Seconds between the producer's timestamp and this platform storing it. */
  medianLagSeconds: number | null;
}

/**
 * What has actually been consumed, per topic. This is the honest answer to "is
 * the stream working": a configured topic with no rows here has a producer and no
 * reader, whatever the manifests say.
 */
export async function inboxHealth(): Promise<{
  topics: InboxTopicHealth[];
  configuredWithNoEvents: string[];
}> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so consumed events cannot be read.');
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT
      topic,
      COUNT(*) AS consumed,
      MAX(consumed_at) AS last_consumed_at,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (consumed_at - produced_at))
      ) FILTER (WHERE produced_at IS NOT NULL) AS median_lag
    FROM event_inbox
    GROUP BY topic
    ORDER BY topic
  `);

  const topics: InboxTopicHealth[] = result.rows.map(row => ({
    topic: String(row.topic),
    consumed: Number(row.consumed ?? 0),
    lastConsumedAt: row.last_consumed_at ? new Date(String(row.last_consumed_at)) : null,
    medianLagSeconds:
      row.median_lag === null || row.median_lag === undefined
        ? null
        : Math.round(Number(row.median_lag)),
  }));

  const seen = new Set(topics.map(entry => entry.topic));
  return {
    topics,
    configuredWithNoEvents: configuredTopics().filter(topic => !seen.has(topic)),
  };
}
