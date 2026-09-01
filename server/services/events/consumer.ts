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
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  propagation,
  trace,
  type Span,
} from '@opentelemetry/api';
import { kafka } from '../../integration/kafka-config';
import { getDb } from '../../db';
import { eventDeadLetters } from '../../../drizzle/event-stream-schema';
import { brokerConfigured } from './outbox';

/**
 * The receiving half of the W3C trace-context contract. The publisher
 * (server/integration/kafka-publisher.ts) injects `traceparent`/`tracestate`
 * onto every message; each consumed message is handled inside a CONSUMER span
 * that continues that trace. With the SDK disabled (NODE_ENV=test or
 * OTEL_SDK_DISABLED) the API calls below are inert no-ops and the handler
 * runs exactly as before.
 *
 * The tracer is resolved lazily per message, not cached at module scope: a
 * module-scope `trace.getTracer()` captures a proxy whose delegate is only
 * wired if the global provider registers on the same @opentelemetry/api
 * instance — which is not guaranteed (tests load the api twice), and lazy
 * resolution always follows the current global provider.
 */

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

/** Kafka headers as a plain string carrier for the W3C propagator. */
function carrierFromHeaders(message: RawMessage): Record<string, string> {
  const carrier: Record<string, string> = {};
  for (const [name, raw] of Object.entries(message.headers ?? {})) {
    if (raw === undefined || raw === null) continue;
    carrier[name] = typeof raw === 'string' ? raw : raw.toString('utf8');
  }
  return carrier;
}

/**
 * Run `handler` inside a CONSUMER span that continues the trace the producer
 * stamped on the message. Exported so the propagation behaviour is pinned by
 * a test without a broker or a database in the loop. The span records and
 * rethrows handler failures, so a batch that cannot be stored still surfaces
 * exactly the error it always did.
 */
export async function withConsumeSpan<T>(
  topic: string,
  partition: number,
  message: RawMessage,
  groupId: string,
  handler: () => Promise<T>
): Promise<T> {
  const extracted = propagation.extract(otelContext.active(), carrierFromHeaders(message));
  const offset = Number(message.offset);
  const span: Span = trace.getTracer('vpp-event-consumer').startSpan(
    'messaging.kafka.consume',
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'kafka',
        'messaging.destination.name': topic,
        'messaging.destination.partition.id': String(partition),
        ...(Number.isSafeInteger(offset) ? { 'messaging.kafka.message.offset': offset } : {}),
        'messaging.kafka.consumer.group': groupId,
      },
    },
    extracted
  );
  try {
    return await otelContext.with(trace.setSpan(extracted, span), handler);
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.end();
  }
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

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type StoreOutcome = 'stored' | 'duplicate' | 'deadLetter';

/** Store one message; the body of the batch loop, unchanged. */
async function storeOne(
  db: Db,
  topic: string,
  partition: number,
  message: RawMessage
): Promise<StoreOutcome> {
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
    return 'deadLetter';
  }

  const producedAt = message.timestamp ? new Date(Number(message.timestamp)) : null;
  const inserted = await db.execute(sql`
    INSERT INTO event_inbox (topic, event_key, partition, message_offset, payload, produced_at)
    VALUES (
      ${topic}, ${eventKey}, ${partition}, ${message.offset}::bigint,
      ${JSON.stringify(payload)}::jsonb,
      ${producedAt && Number.isFinite(producedAt.getTime()) ? producedAt : null}
    )
    ON CONFLICT (topic, event_key) DO NOTHING
    RETURNING id
  `);
  return inserted.rows.length > 0 ? 'stored' : 'duplicate';
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
  const groupId = GROUP_ID();

  for (const message of messages) {
    const outcome = await withConsumeSpan(topic, partition, message, groupId, () =>
      storeOne(db, topic, partition, message)
    );
    if (outcome === 'stored') stored += 1;
    else if (outcome === 'duplicate') duplicates += 1;
    else deadLettered += 1;
  }

  return { received: messages.length, stored, duplicates, deadLettered };
}

/**
 * The offsets to commit for a batch this consumer has stored.
 *
 * A committed offset in Kafka is the *next* offset the group will read, not the
 * last one it read, so committing `lastOffset` would redeliver the final message
 * of every batch forever. `commitOffsetsIfNecessary()` with no argument does not
 * commit at all when `autoCommit` is false — kafkajs only honours the autoCommit
 * interval and threshold there, and both are unset in that mode — so the offsets
 * have to be named explicitly or the group never records a position and a restart
 * resumes at the log's end, skipping everything produced while it was down.
 */
export function nextOffsets(
  topic: string,
  partition: number,
  lastOffset: string
): { topics: { topic: string; partitions: { partition: number; offset: string }[] }[] } {
  const next = BigInt(lastOffset) + 1n;
  return { topics: [{ topic, partitions: [{ partition, offset: next.toString() }] }] };
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
    // Only applies to a group with no committed offset, i.e. the first time this
    // deployment consumes at all. Starting at the log's end there would silently
    // discard every event published before the consumer existed, and the insert
    // is idempotent, so reading the retained log from the start costs duplicates
    // that collapse rather than events that vanish.
    await consumer.subscribe({ topic, fromBeginning: true });
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
      const lastOffset = batch.messages[batch.messages.length - 1]?.offset;
      for (const message of batch.messages) {
        resolveOffset(message.offset);
      }
      await heartbeat();
      if (lastOffset !== undefined) {
        await commitOffsetsIfNecessary(nextOffsets(batch.topic, batch.partition, lastOffset));
      }
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
