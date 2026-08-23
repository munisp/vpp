import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../../_core/trpc';
import {
  acknowledgeDeadLetter,
  listOpenDeadLetters,
  listUndeliverable,
  outboxHealth,
  relayOutboxBatch,
  requeueUndeliverable,
} from '../../services/events/outbox';
import { consumerStatus, inboxHealth } from '../../services/events/consumer';

/**
 * The event stream, read by operators.
 *
 * The question this answers is the one the infrastructure audit could not: are the
 * events this platform produces actually reaching the broker, and is anything
 * reading them back? Both halves report what is recorded, not what is configured —
 * a topic with a producer and no consumer group shows up as exactly that.
 */
export const eventStreamRouter = router({
  status: adminProcedure.query(async () => {
    try {
      const [outbox, inbox] = await Promise.all([outboxHealth(), inboxHealth()]);
      return { outbox, consumer: consumerStatus(), inbox };
    } catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: error instanceof Error ? error.message : 'could not read the event stream state',
      });
    }
  }),

  /** Events the broker refused often enough that they now need a human. */
  undeliverable: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      try {
        return { events: await listUndeliverable(input?.limit ?? 50) };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not read undeliverable events',
        });
      }
    }),

  deadLetters: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional())
    .query(async ({ input }) => {
      try {
        return { deadLetters: await listOpenDeadLetters(input?.limit ?? 50) };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not read dead letters',
        });
      }
    }),

  /**
   * Publish now, on demand. Useful when the relay is not scheduled in this
   * deployment, and after fixing a broker or topic problem.
   */
  relayNow: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(500).default(100) }).optional())
    .mutation(async ({ input }) => {
      try {
        return await relayOutboxBatch(input?.limit ?? 100);
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not drain the outbox',
        });
      }
    }),

  /**
   * Put undeliverable events back in the queue after the cause is fixed. Safe to
   * call twice: a consumer collapses a re-published event by its key.
   */
  requeue: adminProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).max(500).optional() }).optional())
    .mutation(async ({ input }) => {
      try {
        return await requeueUndeliverable(input?.ids);
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not requeue events',
        });
      }
    }),

  /** Mark a dead letter as dealt with. Records who, and changes nothing else. */
  acknowledgeDeadLetter: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const acknowledged = await acknowledgeDeadLetter(input.id, ctx.user.id);
        return {
          acknowledged,
          detail: acknowledged
            ? 'Acknowledged. The event itself is unchanged and still stored.'
            : 'That dead letter does not exist or was already acknowledged.',
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'could not acknowledge the dead letter',
        });
      }
    }),
});
