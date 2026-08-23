/**
 * The transactional outbox: how an event leaves this platform.
 *
 * The rule this file enforces is that **an event is enqueued in the same
 * transaction as the fact it describes, and published by nobody else**. That
 * removes the two ways the previous inline publishing lost events:
 *
 *   - commit succeeded, publish failed  → event lost, log line only;
 *   - publish succeeded, commit rolled back → an event describing a fact that
 *     never happened.
 *
 * With the outbox, both become the same visible state: a `pending` row. The relay
 * drains those rows with `FOR UPDATE SKIP LOCKED`, so several replicas can run it
 * without publishing the same row twice, and delivery is at-least-once — the
 * consumer's side of this (`event_inbox`) is what makes that safe.
 *
 * What this does *not* claim: it does not promise a consumer processed anything,
 * and `published` means only that the broker acknowledged the record.
 */

import { desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db';
import {
  eventDeadLetters,
  eventOutbox,
  type EventOutboxRow,
} from '../../../drizzle/event-stream-schema';
import { kafkaPublisher } from '../../integration/kafka-publisher';

/** How many times the relay retries a topic before it needs a human. */
export const MAX_PUBLISH_ATTEMPTS = 8;

/** Backoff between relay attempts: 2s, 8s, 32s, ... capped at 15 minutes. */
export function backoffMsFor(attempts: number): number {
  const base = 2_000 * 4 ** Math.max(0, attempts - 1);
  return Math.min(base, 15 * 60_000);
}

export interface OutboxEvent {
  topic: string;
  /**
   * The event's business identity. Two enqueues with the same key are the same
   * event: the second is dropped, which is what makes a retried provider
   * callback or a replayed workflow step publish once.
   */
  eventKey: string;
  /** The Kafka message key — ordering and co-partitioning. Defaults to `eventKey`. */
  partitionKey?: string;
  /**
   * The event contract version, stamped into the payload and the Kafka headers.
   * There is no schema registry here, so the contract travels with the record:
   * a consumer that meets a version it does not understand can say so instead of
   * reading fields by position and hoping.
   */
  schemaVersion?: number;
  payload: Record<string, unknown>;
}

export const EVENT_SCHEMA_VERSION = 1;

/**
 * The envelope every published record carries: which topic's contract it claims
 * to satisfy, at which version, and its identity.
 */
export function envelope(event: OutboxEvent): Record<string, unknown> {
  return {
    ...event.payload,
    event_key: event.eventKey,
    schema: event.topic,
    schema_version: event.schemaVersion ?? EVENT_SCHEMA_VERSION,
  };
}

/** Anything that can run a query: the pool, or an open transaction. */
type Querier = {
  execute: (query: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Enqueue an event. Pass the transaction that is writing the business fact —
 * that is the whole point, and calling this outside one gives back the weaker
 * guarantee the outbox exists to remove.
 *
 * Returns whether this call created the row; `false` means an event with that
 * key was already enqueued, which is a successful no-op rather than an error.
 */
export async function enqueueEvent(tx: Querier, event: OutboxEvent): Promise<boolean> {
  const result = await tx.execute(sql`
    INSERT INTO event_outbox (topic, partition_key, event_key, payload)
    VALUES (
      ${event.topic},
      ${event.partitionKey ?? event.eventKey},
      ${event.eventKey},
      ${JSON.stringify(envelope(event))}::jsonb
    )
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * Enqueue outside a caller's transaction, for a fact that is already committed.
 * Weaker than `enqueueEvent` — a crash between the two loses the event — so it
 * is for call sites whose fact is not written by this process.
 */
export async function enqueueEventStandalone(event: OutboxEvent): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so this event cannot be recorded for publishing.');
  return enqueueEvent(db as unknown as Querier, event);
}

export interface RelayResult {
  claimed: number;
  published: number;
  retryable: number;
  undeliverable: number;
  /** Set when nothing was attempted because the platform has no broker configured. */
  skippedReason?: string;
}

/**
 * True when a broker is configured. `KAFKA_BROKERS` unset is a deployment with no
 * stream, which is a legitimate configuration — events accumulate in the outbox
 * and are visible as pending rather than being invented as delivered.
 */
export function brokerConfigured(): boolean {
  return Boolean(process.env.KAFKA_BROKERS);
}

/**
 * How long a claimed event is invisible to other relays while this one publishes
 * it. A relay that dies mid-publish leaves the row claimed, and this is how long
 * before somebody else picks it up.
 */
export const CLAIM_LEASE_SECONDS = 60;

/**
 * Publish one batch of due events.
 *
 * The claim is a single statement — `UPDATE ... WHERE id IN (SELECT ... FOR
 * UPDATE SKIP LOCKED)` — which pushes `next_attempt_at` out by the lease and
 * increments `attempts` as it hands the rows over. Holding a transaction open
 * across the publish instead would keep row locks for the length of a broker
 * round trip; leasing means several replicas can relay concurrently, nobody waits
 * on anybody's lock, and a relay that dies mid-publish only delays the event by
 * the lease rather than stranding it.
 *
 * Delivery is therefore at-least-once: a publish that succeeded but whose row
 * update was lost is published again, which the consumer's unique
 * (topic, event_key) collapses back to one application.
 */
export type PublishFn = (
  topic: string,
  message: { key: string; value: Record<string, unknown>; headers: Record<string, string> }
) => Promise<void>;

const publishToBroker: PublishFn = (topic, message) => kafkaPublisher.publishRecord(topic, message);

export async function relayOutboxBatch(
  limit = 100,
  /** Injected in tests so the claim/mark/retry accounting is provable without a broker. */
  publish: PublishFn = publishToBroker
): Promise<RelayResult> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so the outbox cannot be drained.');
  if (!brokerConfigured()) {
    return {
      claimed: 0,
      published: 0,
      retryable: 0,
      undeliverable: 0,
      skippedReason:
        'KAFKA_BROKERS is not set, so this deployment has no stream to publish to. Events stay pending in the outbox.',
    };
  }

  const claimed = await db.execute<Record<string, unknown>>(sql`
    UPDATE event_outbox
    SET attempts = attempts + 1,
        next_attempt_at = NOW() + ${`${CLAIM_LEASE_SECONDS} seconds`}::interval
    WHERE id IN (
      SELECT id
      FROM event_outbox
      WHERE state = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, topic, partition_key, event_key, payload, attempts
  `);

  let published = 0;
  let retryable = 0;
  let undeliverable = 0;

  for (const row of claimed.rows as unknown as Array<{
    id: number;
    topic: string;
    partition_key: string | null;
    event_key: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>) {
    // The claim already counted this attempt.
    const attempts = Number(row.attempts);
    try {
      await publish(row.topic, {
        key: row.partition_key ?? row.event_key,
        value: row.payload,
        headers: {
          'event-key': row.event_key,
          'event-schema': row.topic,
          'event-schema-version': String(row.payload?.schema_version ?? EVENT_SCHEMA_VERSION),
        },
      });
      await db.execute(sql`
        UPDATE event_outbox
        SET state = 'published', attempts = ${attempts}, published_at = NOW(), last_error = NULL
        WHERE id = ${row.id}
      `);
      published += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempts >= MAX_PUBLISH_ATTEMPTS) {
        // Out of automatic retries. The event is kept and recorded as
        // undeliverable, plus a dead letter so it appears on the operator surface
        // instead of ageing quietly at the bottom of a table.
        await db.execute(sql`
          UPDATE event_outbox
          SET state = 'undeliverable', attempts = ${attempts}, last_error = ${reason.slice(0, 1000)}
          WHERE id = ${row.id}
        `);
        await db.insert(eventDeadLetters).values({
          side: 'produce',
          topic: row.topic,
          eventKey: row.event_key,
          payload: row.payload,
          reason: `The broker did not accept this event after ${attempts} attempts: ${reason}`.slice(0, 1000),
          attempts,
        });
        undeliverable += 1;
      } else {
        await db.execute(sql`
          UPDATE event_outbox
          SET attempts = ${attempts},
              next_attempt_at = NOW() + ${`${Math.round(backoffMsFor(attempts) / 1000)} seconds`}::interval,
              last_error = ${reason.slice(0, 1000)}
          WHERE id = ${row.id}
        `);
        retryable += 1;
      }
    }
  }

  return { claimed: claimed.rows.length, published, retryable, undeliverable };
}

export interface OutboxHealth {
  brokerConfigured: boolean;
  pending: number;
  /** Age of the oldest undelivered event, in seconds; `null` when there is none. */
  oldestPendingAgeSeconds: number | null;
  undeliverable: number;
  publishedLastHour: number;
  relayRunningInThisProcess: boolean;
  detail: string;
}

export async function outboxHealth(): Promise<OutboxHealth> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so the outbox cannot be read.');
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT
      COUNT(*) FILTER (WHERE state = 'pending') AS pending,
      COUNT(*) FILTER (WHERE state = 'undeliverable') AS undeliverable,
      COUNT(*) FILTER (WHERE state = 'published' AND published_at > NOW() - INTERVAL '1 hour') AS published_last_hour,
      MAX(EXTRACT(EPOCH FROM (NOW() - created_at))) FILTER (WHERE state = 'pending') AS oldest_pending_age
    FROM event_outbox
  `);
  const row = result.rows[0] ?? {};
  const pending = Number(row.pending ?? 0);
  const undeliverable = Number(row.undeliverable ?? 0);
  const oldest = row.oldest_pending_age === null || row.oldest_pending_age === undefined
    ? null
    : Math.round(Number(row.oldest_pending_age));

  return {
    brokerConfigured: brokerConfigured(),
    pending,
    oldestPendingAgeSeconds: oldest,
    undeliverable,
    publishedLastHour: Number(row.published_last_hour ?? 0),
    relayRunningInThisProcess: relayRunning(),
    detail: describeOutbox({ pending, undeliverable, oldest }),
  };
}

function describeOutbox(state: { pending: number; undeliverable: number; oldest: number | null }): string {
  if (!brokerConfigured()) {
    return 'No broker is configured (KAFKA_BROKERS is unset), so nothing is published; events are recorded and stay pending.';
  }
  if (state.undeliverable > 0) {
    return `${state.undeliverable} event(s) the broker would not accept are held as undeliverable and need an operator; they are kept, not dropped.`;
  }
  if (state.pending === 0) {
    return 'Every recorded event has been acknowledged by the broker.';
  }
  if (state.oldest !== null && state.oldest > 300) {
    return `${state.pending} event(s) are waiting, the oldest for ${Math.round(state.oldest / 60)} minute(s): the relay is not keeping up or is not running.`;
  }
  return `${state.pending} event(s) are waiting to be published.`;
}

export async function listUndeliverable(limit = 50): Promise<EventOutboxRow[]> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so the outbox cannot be read.');
  return db
    .select()
    .from(eventOutbox)
    .where(eq(eventOutbox.state, 'undeliverable'))
    .orderBy(desc(eventOutbox.id))
    .limit(limit);
}

/**
 * Put undeliverable events back in the queue. An operator does this after fixing
 * the cause (creating the topic, correcting the broker list); the attempt counter
 * is reset because the retries that ran were against the broken state.
 */
export async function requeueUndeliverable(ids?: number[]): Promise<{ requeued: number }> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so the outbox cannot be updated.');
  const scope = ids && ids.length > 0
    ? sql`AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`
    : sql``;
  const result = await db.execute(sql`
    UPDATE event_outbox
    SET state = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL
    WHERE state = 'undeliverable' ${scope}
    RETURNING id
  `);
  return { requeued: result.rows.length };
}

export interface DeadLetterView {
  id: number;
  side: string;
  topic: string;
  eventKey: string;
  reason: string;
  attempts: number;
  createdAt: Date;
}

export async function listOpenDeadLetters(limit = 50): Promise<DeadLetterView[]> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so dead letters cannot be read.');
  const rows = await db
    .select({
      id: eventDeadLetters.id,
      side: eventDeadLetters.side,
      topic: eventDeadLetters.topic,
      eventKey: eventDeadLetters.eventKey,
      reason: eventDeadLetters.reason,
      attempts: eventDeadLetters.attempts,
      createdAt: eventDeadLetters.createdAt,
    })
    .from(eventDeadLetters)
    .where(isNull(eventDeadLetters.acknowledgedAt))
    .orderBy(desc(eventDeadLetters.id))
    .limit(limit);
  return rows;
}

export async function acknowledgeDeadLetter(id: number, userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error('No database connection, so this dead letter cannot be acknowledged.');
  const result = await db.execute(sql`
    UPDATE event_dead_letters
    SET acknowledged_at = NOW(), acknowledged_by = ${userId}
    WHERE id = ${id} AND acknowledged_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

let relayTimer: NodeJS.Timeout | null = null;

/**
 * Start draining the outbox on a schedule. Opt-in via `EVENT_OUTBOX_RELAY_MS` so a
 * deployment that runs the relay in a worker does not also run it in every API
 * replica; without it, nothing publishes and the boot log says so, which is the
 * honest failure — the alternative is a queue that grows with no one watching.
 */
export function startOutboxRelay(): boolean {
  const interval = Number(process.env.EVENT_OUTBOX_RELAY_MS);
  if (!Number.isFinite(interval) || interval < 250) return false;
  if (relayTimer) return true;
  relayTimer = setInterval(() => {
    void relayOutboxBatch().then(
      result => {
        if (result.published > 0 || result.undeliverable > 0) {
          console.log(
            `[EventOutbox] published=${result.published} retryable=${result.retryable} undeliverable=${result.undeliverable}`
          );
        }
      },
      error => console.error('[EventOutbox] relay pass failed:', error)
    );
  }, interval);
  relayTimer.unref?.();
  return true;
}

export function stopOutboxRelay(): void {
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
}

/** Exported for tests and for the health surface's honesty about scope. */
export function relayRunning(): boolean {
  return relayTimer !== null;
}
