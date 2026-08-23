/**
 * The event stream's own record: an outbox on the way out, a landing table on the
 * way in, and dead letters for what neither could complete.
 *
 * Before this, every "publish to Kafka" call site did the same thing: commit the
 * business fact, then `await kafkaPublisher.publishX(...)` in a `try/catch` that
 * logged the failure and carried on. Two consequences, both invisible:
 *
 *   - **Events were lost silently.** A broker that was down, a topic that did not
 *     exist, a pod killed between the commit and the send — each produced a log
 *     line and a database row with no corresponding event, and nothing anywhere
 *     could tell you afterwards which events were missing.
 *   - **Money paths paid for the broker's outage.** KafkaJS retries for ~30 s
 *     before failing, inline, after the settlement row was already committed.
 *
 * `event_outbox` replaces that with a row written in the *same transaction* as the
 * business fact. The relay is the only thing that talks to Kafka, and a publish
 * that never succeeded stays a visible `pending` row rather than a lost event.
 *
 * `event_inbox` is the consumer's half. Kafka's own consumer group offsets say
 * where the consumer is, not what it did; a redelivery after a rebalance is
 * normal, so a handler that is not idempotent double-applies. The unique key on
 * (topic, event_key) makes a redelivery a no-op, and the row is the evidence that
 * this platform actually consumed the event rather than merely publishing into a
 * topic nobody read.
 *
 * Nothing here fabricates delivery: an unpublished event is `pending` or
 * `undeliverable`, never quietly dropped, and no counter reports success for an
 * event the broker did not acknowledge.
 */

import {
  bigint,
  index,
  integer as int,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * An outbox row's life.
 *
 * `undeliverable` is deliberately not called "failed": the event is still here
 * and still publishable by hand once the cause is fixed (a missing topic, a
 * payload the broker rejects). What it is not is delivered, and it will not be
 * retried on the automatic schedule any more, so it needs an operator.
 */
export const eventOutboxStateEnum = pgEnum('event_outbox_state', [
  'pending',
  'published',
  'undeliverable',
]);

export const eventOutbox = pgTable(
  'event_outbox',
  {
    id: serial('id').primaryKey(),
    topic: varchar('topic', { length: 160 }).notNull(),
    /** The Kafka message key: what orders and co-partitions the event. */
    partitionKey: varchar('partition_key', { length: 200 }),
    /**
     * The event's business identity, unique across the outbox. This is what makes
     * a retried callback or a replayed workflow enqueue one event instead of two:
     * the second insert conflicts rather than producing a duplicate event.
     */
    eventKey: varchar('event_key', { length: 200 }).notNull(),
    payload: jsonb('payload').notNull(),
    state: eventOutboxStateEnum('state').notNull().default('pending'),
    attempts: int('attempts').notNull().default(0),
    /** When the relay may next try. Backoff lives here, not in a sleep. */
    nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
    /** What the broker said last time; kept so an operator does not have to guess. */
    lastError: varchar('last_error', { length: 1000 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    publishedAt: timestamp('published_at'),
  },
  table => ({
    eventKeyIdx: uniqueIndex('event_outbox_event_key_key').on(table.eventKey),
    /** The relay's claim query: due pending rows, oldest first. */
    dueIdx: index('event_outbox_due_idx').on(table.state, table.nextAttemptAt),
    topicIdx: index('event_outbox_topic_idx').on(table.topic, table.createdAt),
  })
);

export const eventInbox = pgTable(
  'event_inbox',
  {
    id: serial('id').primaryKey(),
    topic: varchar('topic', { length: 160 }).notNull(),
    /**
     * The event's identity as the producer set it. For events this platform
     * produced it is the outbox `event_key`; for a foreign producer it falls back
     * to the coordinates of the message, which are unique per topic.
     */
    eventKey: varchar('event_key', { length: 200 }).notNull(),
    partition: int('partition').notNull(),
    /** Kafka offsets exceed 2^31 on a busy topic. */
    messageOffset: bigint('message_offset', { mode: 'number' }).notNull(),
    payload: jsonb('payload').notNull(),
    /** When the broker says the producer sent it, when the producer set a timestamp. */
    producedAt: timestamp('produced_at'),
    consumedAt: timestamp('consumed_at').notNull().defaultNow(),
  },
  table => ({
    /** One row per event: a rebalance redelivery conflicts instead of double-applying. */
    identityIdx: uniqueIndex('event_inbox_identity_key').on(table.topic, table.eventKey),
    coordinatesIdx: index('event_inbox_coordinates_idx').on(
      table.topic,
      table.partition,
      table.messageOffset
    ),
    consumedIdx: index('event_inbox_consumed_idx').on(table.topic, table.consumedAt),
  })
);

/** Which side of the stream gave up on an event. */
export const eventDeadLetterSideEnum = pgEnum('event_dead_letter_side', ['produce', 'consume']);

export const eventDeadLetters = pgTable(
  'event_dead_letters',
  {
    id: serial('id').primaryKey(),
    side: eventDeadLetterSideEnum('side').notNull(),
    topic: varchar('topic', { length: 160 }).notNull(),
    eventKey: varchar('event_key', { length: 200 }).notNull(),
    payload: jsonb('payload').notNull(),
    /** Why it stopped: the broker's error, or the handler's. */
    reason: varchar('reason', { length: 1000 }).notNull(),
    attempts: int('attempts').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    /** Set when an operator has dealt with it; never set by the platform itself. */
    acknowledgedAt: timestamp('acknowledged_at'),
    acknowledgedBy: int('acknowledged_by'),
  },
  table => ({
    sideIdx: index('event_dead_letters_side_idx').on(table.side, table.createdAt),
    openIdx: index('event_dead_letters_open_idx').on(table.acknowledgedAt),
  })
);

export type EventOutboxState = (typeof eventOutboxStateEnum.enumValues)[number];
export type EventDeadLetterSide = (typeof eventDeadLetterSideEnum.enumValues)[number];
export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type EventInboxRow = typeof eventInbox.$inferSelect;
export type EventDeadLetterRow = typeof eventDeadLetters.$inferSelect;
